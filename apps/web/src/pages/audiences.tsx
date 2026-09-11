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
} from "@corbits/react-ui";
import { Markdown } from "../markdown.jsx";

type Policy = { audiences?: { name: string; role: string }[]; audienceQuorum?: number };

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
      <div data-tour="audience-packages">
      <Screen
        title="Audience packages"
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
          <Banner title="No audiences are named for this project" />
        ) : null}

        {packages.length === 0 ? (
          <EmptyState
            title="No packages drafted"
            description="Draft this stage to produce one package per named audience."
          />
        ) : (
          <>
            {/* One tab per audience package. */}
            <Tabs
              label="Audience packages"
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
          title="Per-audience decisions"
          tight
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Audience</TableHead>
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
