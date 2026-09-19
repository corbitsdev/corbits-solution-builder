/**
 * Stage 5 — one package per named audience.
 *
 * The per-stakeholder quorum decision (`audience.decide`, once recorded
 * against a parked ledger run) is restored here in a mail-agent shape
 * (CL-8625): each stakeholder's own proceed/revise/reject is appended to
 * their own package artifact's `sb.decisions` through `reviseArtifact`, and
 * the quorum banner is folded client-side from those decisions against the
 * project policy's `audienceQuorum`. Advancing past the stage is still the
 * same "Approve and continue" the other stages use
 * (`pages/workspace/index.tsx`); this only restores the record, not a gate.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, type AudienceDecision, type ProjectDetail } from "../client.js";
import type { ChatMessage } from "../stage-mail.ts";
import { Banner, Button, downloadArtifact, Field, Screen, StateLabel } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { Tabs, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { Markdown } from "../markdown.jsx";
import { buildPackageDeck } from "../deck-save.ts";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the agent's next reply after everything already in `seenIds` —
 * the reply that follows the mail just sent, not one already on the thread.
 * The live reply took ~4 minutes (CL-8636); this polls the thread rather
 * than the round-trip `send()` elsewhere uses, which only reloads once.
 */
async function awaitAgentReply(
  tenantId: string,
  agentAddress: string,
  seenIds: ReadonlySet<string>,
  isCancelled: () => boolean,
): Promise<ChatMessage> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new ApiFailure({
      code: "cancelled",
      message: "Cancelled.",
      correlationId: "-",
      retryable: false,
    });
    const messages = await api.readStageThread(tenantId, [agentAddress]);
    const reply = [...messages].reverse().find((message) => message.author === "agent" && !seenIds.has(message.id));
    if (reply) return reply;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ApiFailure({
    code: "timeout",
    message: "The specialist has not replied yet. Try again shortly.",
    correlationId: "-",
    retryable: true,
  });
}

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

/** The most recent decision recorded, or null if none has been. */
function latestDecision(decisions: readonly AudienceDecision[]): AudienceDecision | null {
  return decisions.length > 0 ? decisions[decisions.length - 1]! : null;
}

const DECISION_LABEL: Record<AudienceDecision["decision"], string> = {
  proceed: "Proceed",
  revise: "Needs revision",
  reject: "Reject",
};

const DECISION_TONE: Record<AudienceDecision["decision"], "success" | "warning" | "error"> = {
  proceed: "success",
  revise: "warning",
  reject: "error",
};

/**
 * One stakeholder's own record on their package: the decisions already
 * appended to `sb.decisions`, and a way to add another.
 */
function DecisionPanel({
  audience,
  decisions,
  onDecide,
}: {
  audience: string;
  decisions: readonly AudienceDecision[];
  onDecide: (decision: AudienceDecision["decision"], note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<AudienceDecision["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = latestDecision(decisions);

  const decide = async (decision: AudienceDecision["decision"]) => {
    setBusy(decision);
    setError(null);
    try {
      await onDecide(decision, note);
      setNote("");
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen-body decision-panel">
      {error ? <Banner tone="error" title={error} /> : null}
      {current ? (
        <StateLabel tone={DECISION_TONE[current.decision]}>
          {audience}: {DECISION_LABEL[current.decision]}
        </StateLabel>
      ) : (
        <StateLabel tone="info">{audience} has not decided yet</StateLabel>
      )}
      {decisions.length > 0 ? (
        <ul className="decision-history">
          {decisions.map((entry, index) => (
            <li key={index}>
              {DECISION_LABEL[entry.decision]} · {new Date(entry.at).toLocaleString()}
              {entry.note ? ` · ${entry.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <Field label={`${audience}'s note (optional)`}>
        <Input value={note} placeholder="Why this decision" onChange={(event) => setNote(event.target.value)} />
      </Field>
      <div className="button-row">
        <Button variant="primary" loading={busy === "proceed"} disabled={busy !== null} onClick={() => void decide("proceed")}>
          Proceed
        </Button>
        <Button loading={busy === "revise"} disabled={busy !== null} onClick={() => void decide("revise")}>
          Needs revision
        </Button>
        <Button variant="ghost" loading={busy === "reject"} disabled={busy !== null} onClick={() => void decide("reject")}>
          Reject
        </Button>
      </div>
    </div>
  );
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
  tenantId,
  agentAddress,
  onChanged,
  onApprove,
  approving,
  canApprove,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  /** The stage 5 specialist's mail address; null while it is still deploying. */
  agentAddress: string | null;
  onChanged: () => void;
  /** Persists the specialist's latest reply as this stage's approved draft and advances. */
  onApprove: () => void;
  approving: boolean;
  /** Whether there is a specialist reply to approve. */
  canApprove: boolean;
}) {
  // Which stakeholders' packages are being written right now: "Write it"
  // sends the mail, then polls the thread for the reply that follows it and
  // persists that reply as each named audience's package artifact — nothing
  // else turns the mail-agent's reply into what the packages list reads
  // (CL-8636). One round at a time; the rows say "Writing…" instead of
  // offering another.
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set());
  const [writeError, setWriteError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => () => {
    cancelledRef.current = true;
  }, []);

  const writePackages = async (names: string[]) => {
    if (!agentAddress || names.length === 0 || writing.size > 0) return;
    setWriteError(null);
    setWriting(new Set(names));
    try {
      const before = await api.readStageThread(tenantId, [agentAddress]);
      const seenIds = new Set(before.map((message) => message.id));
      await api.sendStageMail(tenantId, agentAddress, {
        body: `Write the ${names.length > 1 ? "packages" : "package"} for: ${names.join(", ")}.`,
      });
      const reply = await awaitAgentReply(tenantId, agentAddress, seenIds, () => cancelledRef.current);
      if (cancelledRef.current) return;
      await Promise.all(names.map((name) => api.persistAudiencePackage(detail.project.id, name, reply.body)));
      if (!cancelledRef.current) onChanged();
    } catch (cause) {
      if (!cancelledRef.current) {
        setWriteError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      }
    } finally {
      if (!cancelledRef.current) setWriting(new Set());
    }
  };
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
  const [error, setError] = useState<string | null>(null);
  // Slides are asked for one audience at a time, and a person moves on to
  // the next while the first is still being saved. So each package keeps
  // its own state — being saved, or saved — rather than one slot for
  // whichever tab happens to be open.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [savedNodes, setSavedNodes] = useState<ReadonlySet<string>>(new Set());
  // The slides for a package are its recorded PowerPoint deck, when one
  // exists beside it in the artifact graph (same kind/variant relationship
  // `graph.tsx` groups on); otherwise they are built here from the
  // package's own "Deck outline" section. Either way the browser downloads
  // the bytes itself — there is no host route to save them to.
  const saveSlides = async (packageNodeId: string) => {
    const pkg = packages.find((node) => node.id === packageNodeId);
    const name = pkg?.variant ?? "this stakeholder";
    setSaving((before) => new Set(before).add(packageNodeId));
    setError(null);
    try {
      if (!pkg) throw new Error("That stakeholder's package could not be found.");
      const deck = detail.nodes
        .filter((node) => node.kind === "audience_deck" && node.variant === pkg.variant && node.supersededByNodeId === null)
        .sort((a, b) => b.version - a.version)[0];
      if (deck) {
        const result = await api.artifactContent(tenantId, deck.id);
        downloadArtifact(result.content, `${deck.title}.pptx`);
      } else {
        const packageContent = await api.artifactContent(tenantId, packageNodeId);
        const role = audiences.find((audience) => audience.name === pkg.variant)?.role ?? "";
        const built = await buildPackageDeck({
          projectTitle: detail.project.title,
          audience: name,
          role,
          markdown: packageContent.content,
        });
        downloadArtifact(built.dataUrl, built.filename);
      }
      setSavedNodes((before) => new Set(before).add(packageNodeId));
    } catch (cause) {
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
    saving.has(nodeId) ? "saving" : savedNodes.has(nodeId) ? "saved" : null;

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
    void api.artifactContent(tenantId, selected.id).then((result) => {
      if (!cancelled) setContent(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, tenantId]);

  // The quorum is read off the same project policy `api.stakeholders`
  // already reads for the editor above, rather than off this component's
  // own `Policy` cast, so the banner tracks the same source of truth a
  // decision is checked against server-side one day.
  const [decisionQuorum, setDecisionQuorum] = useState(quorum);
  useEffect(() => {
    void api.stakeholders(detail.project.id).then((result) => setDecisionQuorum(result.audienceQuorum ?? 0)).catch(() => {});
  }, [detail.project.id]);

  // Every package's own decision history, recorded on its `sb.decisions` —
  // fetched for all packages at once so the quorum banner can total proceeds
  // across stakeholders, not just the one open in the tab.
  const [decisionsByNode, setDecisionsByNode] = useState<ReadonlyMap<string, AudienceDecision[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      packages.map((node) => api.audienceDecisions(tenantId, node.id).then((result) => [node.id, result.decisions] as const)),
    ).then((entries) => {
      if (!cancelled) setDecisionsByNode(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, packages.map((node) => node.id).join(",")]);

  const proceeded = packages.filter((node) => latestDecision(decisionsByNode.get(node.id) ?? [])?.decision === "proceed").length;
  const quorumMet = decisionQuorum > 0 && proceeded >= decisionQuorum;

  const decide = async (node: (typeof packages)[number], decision: AudienceDecision["decision"], note: string) => {
    if (!node.variant) return;
    const result = await api.recordAudienceDecision(tenantId, node.id, { audience: node.variant, decision, note });
    setDecisionsByNode((before) => new Map(before).set(node.id, result.decisions));
  };

  return (
    <>
      <Stakeholders projectId={detail.project.id} audiences={audiences} quorum={quorum} onChanged={onChanged} />
      <div data-tour="audience-packages">
      <Screen
        title="Stakeholder packages"
        description="Rough cost, not the firm estimate."
        status={
          missing.length === 0 && packages.length > 0 ? (
            <StateLabel tone="success">Every stakeholder has a package</StateLabel>
          ) : (
            <StateLabel tone="warning">{missing.length} still missing</StateLabel>
          )
        }
      >
        {error ? <Banner tone="error" title="That decision was refused">{error}</Banner> : null}
        {writeError ? <Banner tone="error" title="That package could not be written">{writeError}</Banner> : null}

        {audiences.length === 0 ? (
          <Banner title="No stakeholders are named for this project" />
        ) : null}

        {packages.length > 0 && decisionQuorum > 0 ? (
          <Banner
            tone={quorumMet ? "okay" : "warning"}
            title={
              quorumMet
                ? `Quorum met: ${proceeded} of ${decisionQuorum} required have proceeded`
                : `${proceeded} of ${decisionQuorum} required have proceeded`
            }
          />
        ) : null}

        {packages.length > 0 ? (
          <>
            <StateLabel tone={quorumMet ? "success" : "warning"}>
              {proceeded} proceeded · quorum {decisionQuorum}
            </StateLabel>
            {/* Every named stakeholder's latest decision, folded from each
                package's own `sb.decisions` — the record a person checks
                without opening every tab in turn. */}
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
                  const node = packages.find((candidate) => candidate.variant === audience.name);
                  const decision = node ? latestDecision(decisionsByNode.get(node.id) ?? []) : null;
                  return (
                    <TableRow key={audience.name}>
                      <TableCell>{audience.name}</TableCell>
                      <TableCell>{roleLabel(audience.role)}</TableCell>
                      <TableCell>
                        {decision ? (
                          <StateLabel tone={DECISION_TONE[decision.decision]}>
                            {DECISION_LABEL[decision.decision]}
                          </StateLabel>
                        ) : (
                          <StateLabel tone="warning">Awaiting</StateLabel>
                        )}
                      </TableCell>
                      <TableCell>
                        {decision ? (
                          <span className="inline-note">
                            Recorded {new Date(decision.at).toLocaleString()}
                            {decision.note ? ` · ${decision.note}` : ""}
                          </span>
                        ) : (
                          <span className="inline-note">{node ? "No decision yet." : "No package yet."}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        ) : null}

        {packages.length > 0 ? (
          <div className="button-row">
            <Button
              variant="primary"
              loading={approving}
              disabled={!quorumMet || !canApprove || packages.length === 0}
              onClick={onApprove}
            >
              Approve and continue
            </Button>
            {!quorumMet ? <p className="inline-note">Record the required decisions first.</p> : null}
          </div>
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
                  {writing.has(audience.name) ? (
                    <StateLabel tone="info">Writing…</StateLabel>
                  ) : (
                    <Button
                      loading={false}
                      disabled={!agentAddress || writing.size > 0}
                      onClick={() => void writePackages([audience.name])}
                    >
                      Write it
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {missing.length > 1 ? (
              <Button
                variant="primary"
                loading={writing.size > 1}
                disabled={!agentAddress || writing.size > 0}
                onClick={() => void writePackages(missing.map((audience) => audience.name))}
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
                    <span className="document-fold-digest">
                      Version {selected.version} · written {new Date(selected.createdAt).toLocaleString()}
                    </span>
                  </summary>
                  <div className="document-body document-fold-body">
                    {content ? (
                      <Markdown source={content} />
                    ) : (
                      <p className="inline-note">Loading…</p>
                    )}
                  </div>
                </details>
                {savedNodes.has(selected.id) ? (
                  <Banner
                    tone="okay"
                    title="Slides saved"
                    action={{
                      label: "Dismiss",
                      onClick: () =>
                        setSavedNodes((before) => {
                          const next = new Set(before);
                          next.delete(selected.id);
                          return next;
                        }),
                    }}
                  />
                ) : null}
                {/* The named stakeholder's own record on this package —
                    appended to its `sb.decisions`, not gated on anything. */}
                {selected.variant ? (
                  <DecisionPanel
                    audience={selected.variant}
                    decisions={decisionsByNode.get(selected.id) ?? []}
                    onDecide={(decision, note) => decide(selected, decision, note)}
                  />
                ) : null}
                {/* The slides built from this package's deck outline, and,
                    while the stage is open, a way to write the package again
                    on its own; the others keep their versions and decisions. */}
                <div className="button-row">
                  <Button variant="primary" loading={saving.has(selected.id)} onClick={() => saveSlides(selected.id)}>
                    {saving.has(selected.id) ? "Saving slides…" : "Save slides (.pptx)"}
                  </Button>
                  {selected.variant ? (
                    <Button
                      loading={writing.has(selected.variant)}
                      disabled={!agentAddress || writing.size > 0}
                      onClick={() => void writePackages([selected.variant!])}
                    >
                      {writing.has(selected.variant) ? "Writing…" : "Write it again"}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
      </Screen>
      </div>
    </>
  );
}
