/**
 * Stage 5 — one package per named audience.
 *
 * The per-stakeholder quorum decision (`audience.decide`, once recorded
 * against a parked ledger run) is restored here in a mail-agent shape
 * (CL-8625): each stakeholder's own proceed/revise/reject is appended to
 * their own package artifact's `sb.decisions` through `reviseArtifact`, and
 * the quorum count is folded client-side from those decisions against the
 * project policy's `audienceQuorum` — a note beside the record, not a
 * banner. Advancing past the stage is still the
 * same "Approve and continue" the other stages use
 * (`pages/workspace/index.tsx`); this only restores the record, not a gate.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ArtifactNode, type AudienceDecision, type ProjectDetail } from "../client.js";
import type { ChatMessage } from "../stage-mail.ts";
import { Banner, Button, downloadArtifact, Field, StateLabel } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { Tabs, Input } from "@corbits/react-ui";
import { Markdown } from "../markdown.jsx";
import { buildPackageDeck } from "../deck-save.ts";
import { deckDesignFor } from "../deck-design-settings.ts";
import { slidesSource } from "../deck-templates.ts";
import { audienceOutcome } from "../stage-evidence.ts";
import {
  approveReasonText,
  quorumState,
  type ApproveReason,
  type DecisionRecord,
  type Stage5Evidence,
} from "@solutions-builder/app/project-workflow/contracts";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the reply to the mail just sent — the agent's next turn after
 * everything already in `seenIds`, not a turn already on the thread. This
 * polls the thread itself, since the round-trip `send()` elsewhere uses
 * only reloads once and the reply can take minutes.
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

/** One chip per stakeholder, coloured by their latest recorded decision —
    the quorum readable without opening every tab. Clicking a chip opens its
    package and a small popover where that stakeholder's call is recorded. */
function QuorumChips({
  audiences,
  packages,
  decisionsByNode,
  onSelect,
  onDecide,
}: {
  audiences: { name: string; role: string }[];
  packages: readonly ArtifactNode[];
  decisionsByNode: ReadonlyMap<string, AudienceDecision[]>;
  onSelect: (variant: string) => void;
  onDecide: (node: ArtifactNode, decision: AudienceDecision["decision"], note: string) => Promise<void>;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<AudienceDecision["decision"] | null>(null);
  const [popError, setPopError] = useState<string | null>(null);
  const openNode = packages.find((node) => node.variant === openFor) ?? null;

  const record = async (decision: AudienceDecision["decision"]) => {
    if (!openNode) return;
    setBusy(decision);
    setPopError(null);
    try {
      await onDecide(openNode, decision, note);
      setNote("");
      setOpenFor(null);
    } catch (cause) {
      setPopError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="quorum-wrap" data-tour="audience-decisions">
      <div className="quorum-chips" role="list" aria-label="Quorum">
        {audiences.map((audience) => {
          const node = packages.find((candidate) => candidate.variant === audience.name);
          const latest = node ? latestDecision(decisionsByNode.get(node.id) ?? []) : null;
          return (
            <button
              key={audience.name}
              type="button"
              role="listitem"
              className={`aud-chip${latest ? ` ${latest.decision}` : ""}`}
              disabled={!node?.variant}
              aria-expanded={openFor === node?.variant}
              title={latest ? `${audience.name}: ${DECISION_LABEL[latest.decision]}` : `${audience.name}: no decision yet`}
              onClick={() => {
                if (!node?.variant) return;
                onSelect(node.variant);
                setNote("");
                setPopError(null);
                setOpenFor(openFor === node.variant ? null : node.variant);
              }}
            >
              {audience.name}
            </button>
          );
        })}
      </div>
      {openNode ? (
        <div className="aud-pop">
          {popError ? <p className="inline-note">{popError}</p> : null}
          <Input
            value={note}
            aria-label={`${openNode.variant ?? "Stakeholder"}'s note, optional`}
            placeholder="Their note, optional"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpenFor(null);
            }}
          />
          <div className="aud-btns">
            <Button variant="ghost" loading={busy === "proceed"} disabled={busy !== null} onClick={() => void record("proceed")}>
              Proceed
            </Button>
            <Button variant="ghost" loading={busy === "revise"} disabled={busy !== null} onClick={() => void record("revise")}>
              Needs revision
            </Button>
            <Button variant="ghost" loading={busy === "reject"} disabled={busy !== null} onClick={() => void record("reject")}>
              Reject
            </Button>
          </div>
        </div>
      ) : null}
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
    <div>
      {error ? <Banner tone="error" title={error} /> : null}
      {editing ? (
        <div className="stakeholder-editor">
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
          <Field label="How many must proceed">
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
        <div className="button-row">
          <p className="inline-note">
            {audiences.map((audience) => audience.name).join(" · ") || "No stakeholders"} · {quorum} must proceed
          </p>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}

export function AudiencePackages({
  detail,
  tenantId,
  onChanged,
  onApprove,
  approving,
  canApprove,
  approveReason,
  lastRefusal,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** Persists the specialist's latest reply as this stage's approved draft and advances. */
  onApprove: () => void;
  approving: boolean;
  /** The project workflow's own verdict — the only gate on the Approve button. */
  canApprove: boolean;
  /** Why `canApprove` is false, or null once it is true (`ProjectWorkflowView.allowed.approveReason`). */
  approveReason: ApproveReason | null;
  /** `ProjectWorkflowView.lastRefusal` — carries the quorum breakdown when `approveReason` is `quorum_not_met`. */
  lastRefusal: DecisionRecord | null;
}) {
  // Which stakeholders' packages are being written right now: "Write it"
  // sends the mail, then waits for the reply that follows it and keeps
  // that reply as each named audience's package artifact — nothing else
  // turns the reply into what the packages list reads. One round at a
  // time; the rows say "Writing…" instead of offering another.
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set());
  const [writeError, setWriteError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => () => {
    cancelledRef.current = true;
  }, []);

  const policy = (detail.project.policy ?? {}) as Policy;
  const audiences = youFirst(policy.audiences ?? []);
  const quorum = policy.audienceQuorum ?? 0;

  /** Each audience's index into the stakeholder list `setStakeholders` saved
   *  — the order the specialists deploy in (`policy.audiences` order, not
   *  the "you first" display order), so a package is written by its own
   *  agent whatever the tab order on screen. */
  const audienceIndex = (name: string) => (policy.audiences ?? []).findIndex((audience) => audience.name === name);

  /**
   * Writes one named stakeholder's package with that stakeholder's own
   * specialist (`ensureStage5PackageAgent`, deployed lazily on first use),
   * reading its reply back off its own thread — so one audience's package
   * never carries another's, the way a single shared agent's combined
   * reply could.
   */
  const writeOnePackage = async (name: string) => {
    const index = audienceIndex(name);
    if (index === -1) return;
    const deployment = await api.ensureStage5PackageAgent(detail.project.id, index);
    const before = await api.readStageThread(tenantId, [deployment.address]);
    const seenIds = new Set(before.map((message) => message.id));
    await api.sendStageMail(tenantId, deployment.address, { body: `Write the package for: ${name}.` });
    const reply = await awaitAgentReply(tenantId, deployment.address, seenIds, () => cancelledRef.current);
    if (cancelledRef.current) return;
    await api.persistAudiencePackage(detail.project.id, name, reply.body);
  };

  const writePackages = async (names: string[]) => {
    if (names.length === 0 || writing.size > 0) return;
    setWriteError(null);
    setWriting(new Set(names));
    try {
      await Promise.all(names.map((name) => writeOnePackage(name)));
      if (!cancelledRef.current) onChanged();
    } catch (cause) {
      if (!cancelledRef.current) {
        setWriteError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      }
    } finally {
      if (!cancelledRef.current) setWriting(new Set());
    }
  };

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
      const role = audiences.find((audience) => audience.name === pkg.variant)?.role ?? "";
      let theme = null;
      let themeNotice: string | null = null;
      if (role) {
        try {
          theme = await api.deckTemplateThemeForRole(role);
        } catch (cause) {
          themeNotice = `its style guide could not be read (${cause instanceof ApiFailure ? cause.detail.message : String(cause)}); using the default look`;
        }
      }
      if (slidesSource({ hasRecordedDeck: Boolean(deck), theme }) === "recorded" && deck) {
        const result = await api.artifactContent(tenantId, deck.id);
        downloadArtifact(result.content, `${deck.title}.pptx`);
      } else {
        const packageContent = await api.artifactContent(tenantId, packageNodeId);
        const preferences = await api.deckDesigns();
        const built = await buildPackageDeck({
          projectTitle: detail.project.title,
          audience: name,
          role,
          markdown: packageContent.content,
          design: deckDesignFor(role, preferences),
          ...(theme ? { theme } : {}),
        });
        downloadArtifact(built.dataUrl, built.filename);
      }
      if (themeNotice) setError(`Slides for ${name}: ${themeNotice}.`);
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

  // The same evidence an `approve` decision would carry, folded through the
  // identical `quorumState` the stage 5 rule checks -- purely informational
  // (the live tally the chips already show), never the Approve button's gate:
  // that reads `canApprove`/`approveReason` off the project workflow itself,
  // since only an actual approve attempt tells the workflow whether quorum
  // was met (CL-8687 follow-up).
  const evidence: Stage5Evidence = {
    quorum: decisionQuorum,
    stakeholders: audiences.map((audience) => audience.name),
    decisions: packages.flatMap((node) =>
      node.variant
        ? (decisionsByNode.get(node.id) ?? []).map((decision) => ({
            by: node.variant!,
            outcome: audienceOutcome(decision.decision),
            packageArtifactId: node.artifactId,
            packageVersion: node.version,
          }))
        : [],
    ),
  };
  const quorumOutcome = quorumState(evidence);
  const proceeded = quorumOutcome.proceeded;
  // The workflow's own verdict -- never recomputed here (`approveReasonText`
  // is the one place that translates `approveReason` to copy).
  const reason = approveReason ? approveReasonText(approveReason, lastRefusal) : null;

  const decide = async (node: (typeof packages)[number], decision: AudienceDecision["decision"], note: string) => {
    if (!node.variant) return;
    try {
      const result = await api.recordAudienceDecision(tenantId, node.id, { audience: node.variant, decision, note });
      setError(null);
      setDecisionsByNode((before) => new Map(before).set(node.id, result.decisions));
      // A stakeholder's decision changes the quorum, and so `allowed.approve` —
      // the workspace must re-read the workflow view, not just this pane.
      onChanged();
    } catch (cause) {
      // The popover shows the same message inline (its own `popError`), but a
      // failed write must also be visible here: closing the popover, opening
      // another stakeholder's tab, or simply not noticing the small popover
      // text otherwise reads as "nothing happened" rather than "refused"
      // (CL-8866).
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      throw cause;
    }
  };

  return (
    <div data-tour="audience-packages">
      {error ? <Banner tone="error" title="That decision was refused">{error}</Banner> : null}
      {writeError ? <Banner tone="error" title="That package could not be written">{writeError}</Banner> : null}
      {audiences.length === 0 ? <Banner title="No stakeholders are named for this project" /> : null}

      <Stakeholders projectId={detail.project.id} audiences={audiences} quorum={quorum} onChanged={onChanged} />

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
                  <Button loading={false} disabled={writing.size > 0} onClick={() => void writePackages([audience.name])}>
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
              disabled={writing.size > 0}
              onClick={() => void writePackages(missing.map((audience) => audience.name))}
            >
              Write all {missing.length}
            </Button>
          ) : null}
        </div>
      ) : null}

      {packages.length > 0 ? (
        <>
          <QuorumChips
            audiences={audiences}
            packages={packages}
            decisionsByNode={decisionsByNode}
            onSelect={setActive}
            onDecide={(node, decision, note) => decide(node, decision, note)}
          />
          {decisionQuorum > 0 ? (
            <p className="inline-note">
              {proceeded} of {decisionQuorum} required have proceeded.
            </p>
          ) : null}
          <Tabs
            label="Stakeholder packages"
            active={selected?.variant ?? ""}
            onChange={setActive}
            tabs={packages.map((node) => ({
              id: node.variant ?? node.id,
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
            </p>
          ) : null}
          {selected ? (
            <>
              <div className="doc">
                <div className="docmeta">
                  <span>
                    v{selected.version} · {selected.variant ?? selected.title}
                    {selected.supersededByNodeId ? " · superseded" : ""}
                  </span>
                </div>
                {content ? <Markdown source={content} /> : <p className="inline-note">Loading…</p>}
              </div>
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
              <div className="button-row">
                <Button variant="primary" loading={saving.has(selected.id)} onClick={() => saveSlides(selected.id)}>
                  {saving.has(selected.id) ? "Saving slides…" : "Save slides (.pptx)"}
                </Button>
                {selected.variant ? (
                  <Button
                    loading={writing.has(selected.variant)}
                    disabled={writing.size > 0}
                    onClick={() => void writePackages([selected.variant!])}
                  >
                    {writing.has(selected.variant) ? "Writing…" : "Write it again"}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
          <div className="button-row">
            <Button variant="primary" loading={approving} disabled={!canApprove || packages.length === 0} onClick={onApprove}>
              Approve and continue
            </Button>
            {reason ? <p className="inline-note">{reason}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
