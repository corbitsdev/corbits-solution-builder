/**
 * Stage 5 — one package per named audience, and one recorded decision each.
 *
 * The quorum rule is the point of this surface: `audience.decide` records a
 * decision and never transitions the stage, and `stage.approve` only becomes
 * available once the configured quorum of proceeds is recorded with no reject
 * or revise. The buttons reflect that rather than working around it.
 */
import { useEffect, useState } from "react";
import { api, ApiFailure, type ProjectDetail } from "../client.js";
import { Banner, Button, Field, Screen, StateLabel } from "../components.jsx";
import {
  Textarea,
  EmptyState,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Input,
} from "@corbits/react-ui";
import { Markdown } from "../markdown.jsx";

type Policy = { audiences?: { name: string; role: string }[]; audienceQuorum?: number };

/** A role's name as a person reads it. */
function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * Who the packages are for. Each row is a name and a role; the quorum is how
 * many proceeds approve the stage. Saved as a whole, since the list and the
 * quorum only make sense together, and the lifecycle is rendered again from
 * the new list on the next draft.
 */
function Stakeholders({
  projectId,
  audiences,
  quorum,
  onChanged,
}: {
  projectId: string;
  audiences: { name: string; role: string }[];
  quorum: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState(audiences);
  const [needed, setNeeded] = useState(quorum);
  const [roles, setRoles] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.stakeholders(projectId).then((result) => setRoles(result.roles)).catch(() => setRoles([]));
  }, [projectId]);
  useEffect(() => {
    if (!editing) {
      setRows(audiences);
      setNeeded(quorum);
    }
  }, [audiences, quorum, editing]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setStakeholders(projectId, { audiences: rows, audienceQuorum: needed });
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Stakeholders"
      description="Who each package is written for, and who records a decision on it."
      status={<StateLabel tone="info">{audiences.length} named · {quorum} must proceed</StateLabel>}
      tight
    >
      {error ? <Banner tone="error" title={error} /> : null}
      {editing ? (
        <div className="screen-body stakeholder-editor">
          {rows.map((row, index) => (
            <div key={index} className="stakeholder-row">
              <Input
                aria-label={`Stakeholder ${index + 1} name`}
                value={row.name}
                placeholder="Name"
                onChange={(event) => setRows(rows.map((held, at) => (at === index ? { ...held, name: event.target.value } : held)))}
              />
              <select
                aria-label={`Stakeholder ${index + 1} role`}
                value={row.role}
                onChange={(event) => setRows(rows.map((held, at) => (at === index ? { ...held, role: event.target.value } : held)))}
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
              <Button variant="ghost" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, at) => at !== index))}>
                Remove
              </Button>
            </div>
          ))}
          <div className="button-row">
            <Button onClick={() => setRows([...rows, { name: "", role: "audience_member" }])}>Add a stakeholder</Button>
          </div>
          <Field label="How many must proceed for the stage to be approved">
            <Input
              className="setting-number"
              type="number"
              inputMode="numeric"
              min={0}
              max={rows.length}
              value={String(needed)}
              onChange={(event) => setNeeded(Number(event.target.value))}
            />
          </Field>
          <p className="inline-note">
            The next draft writes one package per stakeholder. Decisions already recorded stay recorded.
          </p>
          <div className="button-row">
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Save stakeholders
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="screen-body">
          <ul className="stakeholder-list">
            {audiences.map((audience) => (
              <li key={audience.name}>
                <strong>{audience.name}</strong> · {roleLabel(audience.role)}
              </li>
            ))}
          </ul>
          <div className="button-row">
            <Button onClick={() => setEditing(true)}>Edit stakeholders…</Button>
          </div>
        </div>
      )}
    </Screen>
  );
}

export function AudiencePackages({
  detail,
  onChanged,
}: {
  detail: ProjectDetail;
  onChanged: () => void;
}) {
  const policy = (detail.project.policy ?? {}) as Policy;
  const audiences = policy.audiences ?? [];
  const quorum = policy.audienceQuorum ?? 0;

  const packages = detail.nodes.filter(
    (node) => node.kind === "audience_package" && node.supersededByNodeId === null,
  );
  const [active, setActive] = useState<string | null>(packages[0]?.id ?? null);
  const [content, setContent] = useState("");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = packages.find((node) => node.id === active) ?? packages[0] ?? null;

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    let cancelled = false;
    void api.artifact(selected.id).then((result) => {
      if (!cancelled) setContent(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const decisions = detail.approvals.filter(
    (approval) => approval.command === "audience.decide",
  );
  const decisionFor = (name: string) =>
    decisions.find((approval) => approval.audienceName === name);
  const proceeded = decisions.filter((approval) => approval.decision === "proceed").length;
  const blocked = decisions.filter((approval) => approval.decision !== "proceed").length;
  const quorumMet = blocked === 0 && proceeded >= quorum;

  const decide = async (audienceName: string, decision: "proceed" | "reject" | "revise") => {
    const node = packages.find((entry) => entry.variant === audienceName) ?? selected;
    if (!node || !detail.current) return;
    setBusy(audienceName);
    setError(null);
    try {
      await api.command(detail.project.id, "audience.decide", {
        expectedRevision: detail.project.revision,
        runId: detail.current.id,
        audienceName,
        decision,
        versions: [
          { artifactId: node.artifactId, versionId: node.id, contentHash: node.contentHash },
        ],
        rationale,
      });
      setRationale("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Stakeholders projectId={detail.project.id} audiences={audiences} quorum={quorum} onChanged={onChanged} />
      <div data-tour="audience-packages">
      <Screen
        title="Stakeholder packages"
        description="Rough cost, not the firm estimate."
        status={
          quorumMet ? (
            <StateLabel tone="success">Quorum met — {proceeded}/{quorum}</StateLabel>
          ) : blocked > 0 ? (
            <StateLabel tone="error">{blocked} blocking decision</StateLabel>
          ) : (
            <StateLabel tone="warning">
              {proceeded}/{quorum} recorded
            </StateLabel>
          )
        }
      >
        {error ? <Banner tone="error" title="That decision was refused">{error}</Banner> : null}

        {audiences.length === 0 ? (
          <Banner title="No stakeholders are named for this project" />
        ) : null}

        {packages.length === 0 ? (
          <EmptyState
            title="No packages drafted"
            description="Draft this stage to produce one package per stakeholder."
          />
        ) : (
          <>
            {/* One tab per audience package. */}
            <Tabs
              label="Stakeholder packages"
              active={selected?.id ?? ""}
              onChange={setActive}
              tabs={packages.map((node) => ({
                id: node.id,
                label: node.variant ?? node.title,
              }))}
            >
              {() => null}
            </Tabs>

            {selected ? (
              <>
                <div className="document-body">
                  {content ? (
                    <Markdown source={content} />
                  ) : (
                    <p className="inline-note">Loading…</p>
                  )}
                </div>
              </>
            ) : null}
          </>
        )}
      </Screen>
      </div>

      {audiences.length > 0 ? (
        <div data-tour="audience-decisions">
        <Screen
          title="Per-stakeholder decisions"
          tight
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stakeholder</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Record</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audiences.map((audience) => {
                const recorded = decisionFor(audience.name);
                return (
                  <TableRow key={audience.name}>
                    <TableCell>{audience.name}</TableCell>
                    <TableCell>{audience.role.replace(/_/g, " ")}</TableCell>
                    <TableCell>
                      {recorded ? (
                        <StateLabel
                          tone={recorded.decision === "proceed" ? "success" : "error"}
                        >
                          {recorded.decision}
                        </StateLabel>
                      ) : (
                        <StateLabel tone="warning">Awaiting</StateLabel>
                      )}
                    </TableCell>
                    <TableCell>
                      {recorded ? (
                        <span className="inline-note">
                          Recorded {new Date(recorded.createdAt).toLocaleString()}. Decisions are
                          immutable.
                        </span>
                      ) : (
                        <div className="button-row">
                          <Button
                            loading={busy === audience.name}
                            onClick={() => decide(audience.name, "proceed")}
                          >
                            Proceed
                          </Button>
                          <Button onClick={() => decide(audience.name, "revise")}>Revise</Button>
                          <Button
                            variant="destructive"
                            onClick={() => decide(audience.name, "reject")}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="screen-body">
            <Field label="Rationale">
              <Textarea value={rationale} onChange={(event) => setRationale(event.target.value)} />
            </Field>
            {blocked > 0 ? (
              <Banner tone="error" title="A reject or revise blocks approval" />
            ) : quorumMet ? (
              <Banner tone="okay" title="Quorum met. Stage 5 can be approved" />
            ) : null}
          </div>
        </Screen>
        </div>
      ) : null}
    </>
  );
}
