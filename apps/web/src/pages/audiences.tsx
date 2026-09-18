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
import { deliverGate, submitThen } from "../run-signal.ts";
import { standingForProject } from "../run-fold.ts";
import { Banner, Button, Field, Screen, StateLabel, versionDigest } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import {
  Textarea,
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
/** The person's own entry — the stakeholder named "You" — ahead of everyone else, the rest as listed. */
function youFirst<T extends { name: string }>(list: readonly T[]): T[] {
  const isYou = (entry: T) => entry.name.trim().toLowerCase() === "you";
  return [...list.filter(isYou), ...list.filter((entry) => !isYou(entry))];
}

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
              <Dictated
                value={row.name}
                onValueChange={(name) => setRows(rows.map((held, at) => (at === index ? { ...held, name } : held)))}
                align="center"
              >
                <Input
                  aria-label={`Stakeholder ${index + 1} name`}
                  value={row.name}
                  placeholder="Name"
                  onChange={(event) => setRows(rows.map((held, at) => (at === index ? { ...held, name: event.target.value } : held)))}
                />
              </Dictated>
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
  drafting,
  onDraftPackages,
}: {
  detail: ProjectDetail;
  onChanged: () => void;
  /** A round is under way: the rows say so instead of offering another. */
  drafting: boolean;
  /** Writes these stakeholders' packages, by name, leaving the others as they are. */
  onDraftPackages: (audiences: string[]) => void;
}) {
  const policy = (detail.project.policy ?? {}) as Policy;
  const audiences = youFirst(policy.audiences ?? []);
  const quorum = policy.audienceQuorum ?? 0;

  // Packages in the stakeholders' order, so the tabs and the decisions
  // table read the same way, with the person's own first.
  const rank = (name: string | null) => {
    const index = audiences.findIndex((audience) => audience.name === name);
    return index === -1 ? audiences.length : index;
  };
  const packages = detail.nodes
    .filter((node) => node.kind === "audience_package" && node.supersededByNodeId === null)
    .sort((a, b) => rank(a.variant) - rank(b.variant));
  // The open tab is a stakeholder, not a version: writing a package again
  // gives it a new version id, and a tab keyed on the id fell back to the
  // first stakeholder the moment the rewrite landed.
  const [active, setActive] = useState<string | null>(packages[0]?.variant ?? null);
  const [content, setContent] = useState("");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slides are asked for one audience at a time, and a person moves on to
  // the next while the first is still being saved. So each package keeps
  // its own state — being saved, or where its slides went — rather than one
  // slot for whichever tab happens to be open.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [savedPaths, setSavedPaths] = useState<ReadonlyMap<string, string>>(new Map());
  // The slides for a package are the PowerPoint stage 5 already recorded
  // beside it. Saving writes those bytes; the host does not build a deck.
  const saveSlides = async (packageNodeId: string) => {
    setSaving((before) => new Set(before).add(packageNodeId));
    setError(null);
    try {
      const result = await api.saveSlidesFor(packageNodeId);
      setSavedPaths((before) => new Map(before).set(packageNodeId, result.path));
    } catch (cause) {
      const name = packages.find((node) => node.id === packageNodeId)?.variant ?? "this stakeholder";
      setError(`Slides for ${name}: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
    } finally {
      setSaving((before) => {
        const next = new Set(before);
        next.delete(packageNodeId);
        return next;
      });
    }
  };
  const slidesState = (nodeId: string): "saving" | "saved" | null =>
    saving.has(nodeId) ? "saving" : savedPaths.has(nodeId) ? "saved" : null;

  const selected = packages.find((node) => node.variant === active) ?? packages[0] ?? null;
  // A stakeholder whose package was never written, or failed to be: the
  // round writes the ones it can and reports the rest, so these are offered
  // one by one rather than the whole stage again.
  const missing = audiences.filter((audience) => !packages.some((node) => node.variant === audience.name));

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

  // A decision belongs to the review it was recorded on. Reopening the stage
  // starts a new run and a clean review; what was decided before is history,
  // shown as such beside the stakeholder.
  const decisions = detail.approvals.filter(
    (approval) => approval.command === "audience.decide" && approval.runId === detail.current?.id,
  );
  const decisionFor = (name: string) =>
    decisions.find((approval) => approval.audienceName === name);
  const earlierDecisionFor = (name: string) =>
    [...detail.approvals]
      .reverse()
      .find((approval) => approval.command === "audience.decide" && approval.runId !== detail.current?.id && approval.audienceName === name);
  const proceeded = decisions.filter((approval) => approval.decision === "proceed").length;
  const blocked = decisions.filter((approval) => approval.decision !== "proceed").length;
  const quorumMet = blocked === 0 && proceeded >= quorum;

  // The ledger records a stakeholder's decision only once the packages have
  // been sent for review (stage 5 in waiting_approval). Nothing on this
  // screen sends them as a step of its own: the first decision does, with
  // every current package as what is under review, and then records itself.
  const inProgress = detail.current?.state === "in_progress";
  const sent = detail.current?.state === "waiting_approval";
  const everyoneHasOne = audiences.length > 0 && missing.length === 0;

  /**
   * Reopens the review: routes the stage back so the packages can be revised.
   * The decisions recorded on this review stay recorded, as history; the new
   * review starts clean, so a stakeholder who asked for a revision decides
   * again on the revised package.
   *
   * Resuming the stage after this — re-entering its loop rather than merely
   * marking it backtracked — is CL-8461: the workspace screen shows the
   * disabled "Resume" action and the note once this lands.
   */
  const reopen = async () => {
    if (!detail.current) return;
    setBusy("reopen");
    setError(null);
    try {
      const versions = packages.map((entry) => ({ artifactId: entry.artifactId, versionId: entry.id, contentHash: entry.contentHash }));
      await deliverGate(detail, 5, await standingForProject(detail).catch(() => null), {
        command: "stage.revise",
        runId: detail.current.id,
        versions,
        rationale: "Reopened to revise the packages.",
        reason: "Reopened to revise the packages.",
        targetStage: 5,
      });
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (audienceName: string, decision: "proceed" | "reject" | "revise") => {
    const node = packages.find((entry) => entry.variant === audienceName) ?? selected;
    if (!node || !detail.current) return;
    setBusy(audienceName);
    setError(null);
    try {
      const standing = await standingForProject(detail).catch(() => null);
      const intent = {
        command: "audience.decide" as const,
        runId: detail.current.id,
        audienceName,
        decision,
        versions: [{ artifactId: node.artifactId, versionId: node.id, contentHash: node.contentHash }],
        rationale,
      };
      // The first stakeholder to decide sends the packages for review; the
      // run parks at the gate and the decision lands there.
      if (inProgress) {
        await submitThen(
          detail,
          5,
          standing,
          {
            runId: detail.current.id,
            versions: packages.map((entry) => ({ artifactId: entry.artifactId, versionId: entry.id, contentHash: entry.contentHash })),
          },
          intent,
        );
      } else {
        await deliverGate(detail, 5, standing, intent);
      }
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

        {missing.length > 0 ? (
          <div className="packages-missing" role="status">
            <p className="packages-missing-title">
              {packages.length === 0
                ? "No packages yet."
                : missing.length === 1
                  ? "One stakeholder has no package yet."
                  : `${missing.length} stakeholders have no package yet.`}
            </p>
            <ul className="packages-missing-list">
              {missing.map((audience) => (
                <li key={audience.name}>
                  <span>
                    <strong>{audience.name}</strong> · {roleLabel(audience.role)}
                  </span>
                  {inProgress ? (
                    <Button loading={drafting} onClick={() => onDraftPackages([audience.name])}>
                      Write it
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {missing.length > 1 && inProgress ? (
              <Button
                variant="primary"
                loading={drafting}
                onClick={() => onDraftPackages(missing.map((audience) => audience.name))}
              >
                Write all {missing.length}
              </Button>
            ) : null}
          </div>
        ) : null}

        {packages.length === 0 ? null : (
          <>
            {/* One tab per audience package. */}
            <Tabs
              label="Stakeholder packages"
              active={selected?.variant ?? ""}
              onChange={setActive}
              tabs={packages.map((node) => ({
                id: node.variant ?? node.id,
                // The tab says where its slides stand, so the person need
                // not come back to each one to find out.
                label: `${node.variant ?? node.title}${
                  slidesState(node.id) === "saving" ? " · saving slides…" : slidesState(node.id) === "saved" ? " · slides saved" : ""
                }`,
              }))}
            >
              {() => null}
            </Tabs>
            {saving.size > 0 ? (
              <p className="inline-note" aria-live="polite">
                Saving slides for {packages.filter((node) => saving.has(node.id)).map((node) => node.variant ?? node.title).join(", ")}.
                Keep going; each tab says when its slides are saved.
              </p>
            ) : null}

            {selected ? (
              <>
                {/* The package itself stays folded: one line says which
                    version this is and when it was written, and opening it
                    shows the report. The fold is one element across the
                    tabs, so it stays open while reading several in turn. */}
                <details className="document-fold">
                  <summary className="document-fold-summary">
                    <span className="document-fold-title">{selected.title}</span>
                    <span className="document-fold-digest">{versionDigest(selected)}</span>
                  </summary>
                  <div className="document-body document-fold-body">
                    {content ? (
                      <Markdown source={content} />
                    ) : (
                      <p className="inline-note">Loading…</p>
                    )}
                  </div>
                </details>
                {savedPaths.has(selected.id) ? (
                  <Banner
                    tone="okay"
                    title={`Saved to ${savedPaths.get(selected.id)}`}
                    action={{
                      label: "Dismiss",
                      onClick: () =>
                        setSavedPaths((before) => {
                          const next = new Map(before);
                          next.delete(selected.id);
                          return next;
                        }),
                    }}
                  />
                ) : null}
                {/* The slides built from this package's deck outline, and,
                    while the stage is open, a way to write the package again
                    on its own; the others keep their versions and decisions. */}
                <div className="button-row">
                  <Button variant="primary" loading={saving.has(selected.id)} onClick={() => saveSlides(selected.id)}>
                    {saving.has(selected.id) ? "Saving slides…" : "Save slides (.pptx)"}
                  </Button>
                  {selected.variant && inProgress && !decisionFor(selected.variant) ? (
                    <Button loading={drafting} onClick={() => onDraftPackages([selected.variant!])}>
                      Write this package again
                    </Button>
                  ) : null}
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
          {inProgress && everyoneHasOne ? (
            <Banner title="The first decision sends every package for review, then records itself." />
          ) : inProgress ? (
            <Banner tone="warning" title="Decisions wait until every stakeholder has a package." />
          ) : sent && blocked > 0 ? (
            <Banner
              tone="warning"
              title="A revise or reject blocks approval. Reopen the review to revise the packages; everyone then decides again on the new versions."
              action={{ label: busy === "reopen" ? "Reopening…" : "Reopen for revision", onClick: () => void reopen() }}
            />
          ) : sent ? (
            <Banner
              tone="okay"
              title="The packages are under review. Decisions are recorded against these versions; reopen the review to change a package."
              action={{ label: busy === "reopen" ? "Reopening…" : "Reopen for revision", onClick: () => void reopen() }}
            />
          ) : null}
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
                          {/* What they said on an earlier review is history beside
                              the buttons, never in place of them. */}
                          {earlierDecisionFor(audience.name) ? (
                            <span className="inline-note">
                              Said {earlierDecisionFor(audience.name)!.decision} on an earlier review; decides again here.
                            </span>
                          ) : null}
                          <Button
                            loading={busy === audience.name}
                            disabled={!(sent || everyoneHasOne)}
                            onClick={() => decide(audience.name, "proceed")}
                          >
                            Proceed
                          </Button>
                          <Button disabled={!(sent || everyoneHasOne)} onClick={() => decide(audience.name, "revise")}>
                            Revise
                          </Button>
                          <Button
                            variant="destructive"
                            disabled={!(sent || everyoneHasOne)}
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
              <Dictated value={rationale} onValueChange={setRationale} align="start">
                <Textarea value={rationale} onChange={(event) => setRationale(event.target.value)} />
              </Dictated>
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
