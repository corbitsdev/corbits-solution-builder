/**
 * Stage 5 — one package per named audience.
 *
 * Each stakeholder's own proceed/revise/reject is its own `project.decision`
 * signal on the project workflow run -- a stage-5 `audience` decision, same
 * `decide()` path every other stage decision uses (CL-8870). The quorum
 * tally is read straight off the workflow view (`ProjectWorkflowView`'s
 * `audienceDecisions`/`stage5Quorum`), never folded here and never read off
 * artifact metadata. Advancing past the stage is still the same "Approve and
 * continue" the other stages use (`pages/workspace/index.tsx`); this only
 * records the vote, not a gate -- `stage5Rule` (`project-workflow/contracts.ts`)
 * is the only place quorum is enforced.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, STAKEHOLDER_ROLES, type ArtifactNode, type ProjectDetail } from "../client.js";
import type { ChatMessage } from "../stage-mail.ts";
import { Banner, Button, CopyButton, downloadArtifact, Field, StateLabel } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { Tabs, Input, Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { printHtmlDocument } from "../print.tsx";
import { slidesPrintHtml } from "../slides-print.ts";
import { openInGoogleSlides } from "../google-slides.ts";
import { Markdown } from "../markdown.jsx";
import { buildPackageDeck, deckFileName } from "../deck-save.ts";
import { deckDesignFor } from "../deck-design-settings.ts";
import { slidesSource } from "../deck-templates.ts";
import { SlidePreview } from "../slide-preview.tsx";
import { packageNudge, packageReplyProblem, packageRequest } from "../package-request.ts";
import { placeMockups, type MockupShot } from "../mockup-shots.ts";
import { cachedFramedMockupShots } from "../mockup-cache.ts";
import { isHtmlDocument } from "./workspace/guidance.ts";
import { useBusyWhile } from "../use-busy.ts";
import { packageReplyFor } from "../package-reply.ts";
import { packagesByStakeholder } from "../package-lineages.ts";
import { unrecordedPackageRevisions } from "../package-revisions.ts";
import { deckFrom, packageOutlineProblem, type Deck, type TemplateTheme } from "@solutions-builder/app/deck";
import { packageRefOf, recordAudienceVote, type StageApprovalDeps } from "../stage-approval.ts";
import { stageRefusalMessage } from "../stage-evidence.ts";
import type { ProjectWorkflowView } from "../project-workflow.ts";
import {
  approveReasonText,
  type ApproveReason,
  type AudienceVote,
  type DecisionRecord,
} from "@solutions-builder/app/project-workflow/contracts";

const audienceApprovalDeps: StageApprovalDeps = {
  view: (projectId: string) => api.projectWorkflowView(projectId),
  decide: (projectId: string, decision: Record<string, unknown>) => api.decide(projectId, decision),
  now: () => new Date().toISOString(),
};

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the specialist's answer to the package request just sent for
 * `name` — the reply paired with that request (`packageReplyFor`), not the
 * next agent turn on the thread: every stakeholder's package is asked of the
 * one stage 5 deployment (#41 step 3), so two requests in flight share a
 * thread and only pairing tells their replies apart. This polls the thread
 * itself, since the round-trip `send()` elsewhere uses only reloads once and
 * the reply can take minutes.
 */
async function awaitPackageReply(
  tenantId: string,
  agentAddress: string,
  seenIds: ReadonlySet<string>,
  name: string,
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
    const reply = packageReplyFor(messages, seenIds, name);
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
/** The stakeholder named "You": the person themselves. */
function isYou(entry: { name: string }): boolean {
  return entry.name.trim().toLowerCase() === "you";
}

/** The person's own entry — the stakeholder named "You" — ahead of everyone else, the rest as listed. */
function youFirst<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list.filter(isYou), ...list.filter((entry) => !isYou(entry))];
}

function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

const DECISION_LABEL: Record<AudienceVote["decision"], string> = {
  proceed: "Proceed",
  revise: "Needs revision",
  reject: "Reject",
};

/** One chip per stakeholder, coloured by their latest recorded vote (read
    off the workflow view, `ProjectWorkflowView.audienceDecisions`) — the
    quorum readable without opening every tab. Clicking a chip opens its
    package and a small popover where that stakeholder's call is recorded. */
function QuorumChips({
  audiences,
  packages,
  votesByAudience,
  staleVoters,
  onSelect,
  onDecide,
}: {
  audiences: { name: string; role: string }[];
  packages: readonly ArtifactNode[];
  votesByAudience: Readonly<Record<string, AudienceVote>>;
  /** Stakeholders whose vote names an earlier package than their current
   *  one (`stage5Quorum.stale`): shown as needing a new decision, never as
   *  their old call (#50). */
  staleVoters: ReadonlySet<string>;
  onSelect: (variant: string) => void;
  onDecide: (node: ArtifactNode, decision: AudienceVote["decision"], note: string) => Promise<void>;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<AudienceVote["decision"] | null>(null);
  const [popError, setPopError] = useState<string | null>(null);
  const openNode = packages.find((node) => node.variant === openFor) ?? null;

  const record = async (decision: AudienceVote["decision"]) => {
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
          const latest = votesByAudience[audience.name] ?? null;
          const stale = latest !== null && staleVoters.has(audience.name);
          return (
            <button
              key={audience.name}
              type="button"
              role="listitem"
              className={`aud-chip${latest && !stale ? ` ${latest.decision}` : ""}${stale ? " stale" : ""}`}
              disabled={!node?.variant}
              aria-expanded={openFor === node?.variant}
              title={
                stale
                  ? `${audience.name}: decided on an earlier package; needs a new decision`
                  : latest
                    ? `${audience.name}: ${DECISION_LABEL[latest.decision]}`
                    : `${audience.name}: no decision yet`
              }
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
  onSaved,
}: {
  projectId: string;
  audiences: { name: string; role: string }[];
  quorum: number;
  onChanged: () => void;
  /** Fires after a successful save, in addition to `onChanged` — a stage-5
   *  review already open must recapture the new policy rather than sit on
   *  whatever quorum was in effect when it opened (CL-8891). */
  onSaved?: () => void;
}) {
  const [rows, setRows] = useState(audiences);
  const [needed, setNeeded] = useState(quorum);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error ? <Banner tone="error" title={error} /> : null}
      <div className="button-row">
        <p className="inline-note">
          {audiences.map((audience) => audience.name).join(" · ") || "No stakeholders"} · {quorum} must proceed
        </p>
        {/* A disclosure (#678): the same control opens and closes the panel. */}
        <button type="button" className="disclosure" aria-expanded={editing} aria-controls="stakeholder-panel" onClick={() => setEditing(!editing)}>
          <ChevronRight className="disclosure-chevron" aria-hidden="true" />
          Manage stakeholders
        </button>
      </div>
      {editing ? (
        <div className="stakeholder-editor" id="stakeholder-panel">
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
                {STAKEHOLDER_ROLES.map((role) => (
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
      ) : null}
    </div>
  );
}

/** What the strip says while `name`'s package is being written. */
function packageWork(name: string): string {
  if (isYou({ name })) return "Writing your approval package";
  return `Writing ${name}'s package`;
}

export function AudiencePackages({
  detail,
  tenantId,
  onChanged,
  workflowView,
  onStakeholdersSaved,
  messages = [],
}: {
  detail: ProjectDetail;
  /** The stage's thread (#597): a package rewritten on request in the chat is recorded from it. */
  messages?: readonly ChatMessage[];
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** The project workflow's own view -- `audienceDecisions`/`stage5Quorum`
   *  are the quorum tally's ONE source (CL-8870), never artifact metadata. */
  workflowView: ProjectWorkflowView | null;
  /** Recaptures a fresh `open_review` against whatever review is currently
   *  open, right after the stakeholder list/quorum is saved -- an edit made
   *  while a review is open must never leave it checked against the old
   *  policy (CL-8891). Best-effort: a review not yet open simply stays
   *  unopened until it is reachable. */
  onStakeholdersSaved?: () => void;
}) {
  // Which stakeholders' packages are being written right now: "Generate
  // approval package" sends the mail, then waits for the reply that follows it and keeps
  // that reply as each named audience's package artifact — nothing else
  // turns the reply into what the packages list reads. One round at a
  // time; the rows say "Writing…" instead of offering another.
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set());
  const [writeError, setWriteError] = useState<string | null>(null);
  // The round is work the person waits on whichever tab is open, and the
  // strip says whose package is being written (#223).
  const writingNames = [...writing];
  useBusyWhile(writingNames.length > 0, writingNames.length === 1 ? packageWork(writingNames[0]!) : `Writing ${String(writingNames.length)} packages`);
  const cancelledRef = useRef(false);
  useEffect(() => () => {
    cancelledRef.current = true;
  }, []);

  const policy = (detail.project.policy ?? {}) as Policy;
  const audiences = youFirst(policy.audiences ?? []);
  const quorum = policy.audienceQuorum ?? 0;

  // The approved stage 4 design, read once per approved version: its
  // screens fill every deck's slides as decorative filler (#227), on screen
  // and in the file alike. Only an HTML mockup has screens to draw.
  const designRef = workflowView?.reviews[4]?.status === "approved" ? workflowView.reviews[4].artifactId : null;
  const [designHtml, setDesignHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!designRef) {
      setDesignHtml(null);
      return;
    }
    let cancelled = false;
    void api.artifactContent(tenantId, designRef).then(
      (result) => {
        if (!cancelled) setDesignHtml(isHtmlDocument(result.content) ? result.content : null);
      },
      () => {
        if (!cancelled) setDesignHtml(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [designRef, tenantId]);
  // The screens, drawn once per design and kept for every preview and save.
  const shotsRef = useRef<{ key: string; shots: Promise<MockupShot[]> } | null>(null);
  const designShots = (): Promise<MockupShot[]> => {
    if (!designHtml || !designRef) return Promise.resolve([]);
    if (shotsRef.current?.key !== designRef) shotsRef.current = { key: designRef, shots: cachedFramedMockupShots(designHtml).catch(() => []) };
    return shotsRef.current.shots;
  };

  /**
   * Writes one named stakeholder's package with the stage's one specialist
   * (`ensureStageAgent`, the same deployment the stage's thread is with),
   * asking for that stakeholder by name and role in the request itself and
   * reading back the reply paired with that request — so one audience's
   * package never carries another's, and a stakeholder added or renamed
   * after the stage opened is written for as named now, with no redeploy
   * (#41 step 3).
   */
  const writeOnePackage = async (name: string) => {
    const audience = (policy.audiences ?? []).find((entry) => entry.name === name);
    if (!audience) return;
    const deployment = await api.ensureStageAgent(detail.project.id, 5);
    const before = await api.readStageThread(tenantId, [deployment.address]);
    const seenIds = new Set(before.map((message) => message.id));
    // The approved design this stage opened with (the review at stage 4
    // names the exact artifact), read fresh and carried in the request: the
    // specialist's opening turn may be pages back by now, or on an earlier
    // deployment's thread after a redeploy (#115).
    const designReview = workflowView?.reviews[4];
    const design =
      designReview?.status === "approved"
        ? await api.artifactContent(tenantId, designReview.artifactId).then((result) => result.content, () => null)
        : null;
    // The deck's brief (#246): the design documents that apply to this
    // project and the theme render_deck should draw with. Best effort — a
    // brief that cannot be read never stops a package being asked for.
    const brief = await api.deckBrief(detail.project.id, audience.role).catch(() => null);
    await api.sendStageMail(tenantId, deployment.address, {
      body: packageRequest(audience, design, brief, { audiences: policy.audiences ?? [], quorum: policy.audienceQuorum ?? 0 }),
    });
    let reply = await awaitPackageReply(tenantId, deployment.address, seenIds, name, () => cancelledRef.current);
    if (cancelledRef.current) return;
    // Not every reply is a package (#220): one with no deck outline is
    // refused and never recorded. The specialist is asked once more in the
    // same thread, told what was missing and that the reply itself is the
    // package (#225); a second miss is said so the button stays offered.
    let problem = packageReplyProblem(name, reply.body);
    if (problem) {
      const seenBefore = new Set((await api.readStageThread(tenantId, [deployment.address])).map((message) => message.id));
      await api.sendStageMail(tenantId, deployment.address, { body: packageNudge(audience, packageOutlineProblem(reply.body) ?? "it has no deck outline") });
      reply = await awaitPackageReply(tenantId, deployment.address, seenBefore, name, () => cancelledRef.current);
      if (cancelledRef.current) return;
      problem = packageReplyProblem(name, reply.body);
      if (problem) throw new Error(problem);
    }
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

  // One package per stakeholder, the newest, in the stakeholders' order so
  // the tabs and the decisions table read the same way, the person's own
  // first (#122).
  const packages = packagesByStakeholder(detail.nodes, audiences);

  // A package the presentation creator rewrote on request in the chat is
  // recorded as the stakeholder's next version (#597); until now only
  // the "Write package" flow's own reply was, and the slides kept the first
  // version however many times the person asked. Each reply is recorded
  // once; a stakeholder whose package is being written is left to that flow.
  const recordedReplies = useRef(new Set<string>());
  useEffect(() => {
    for (const revision of unrecordedPackageRevisions(messages, detail.nodes, audiences)) {
      if (writing.has(revision.name) || recordedReplies.current.has(revision.message.id)) continue;
      recordedReplies.current.add(revision.message.id);
      void api
        .persistAudiencePackage(detail.project.id, revision.name, revision.message.body)
        .then(() => onChanged())
        .catch(() => recordedReplies.current.delete(revision.message.id));
    }
    // `audiences` is derived from `detail`; `onChanged` is the page's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, detail.nodes, writing]);
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
  //
  // Three ways out of one menu (#232): the PowerPoint file; the same
  // slides printed one per page, which the system dialog saves as a PDF;
  // and Google Slides, which gets the PowerPoint uploaded through the
  // host's Google Drive connection, converted, and opened (#233). Without
  // that connection the PowerPoint is saved and Slides opened for a manual
  // import, with a word on where to connect.
  const exportSlides = async (packageNodeId: string, how: "pptx" | "pdf" | "google") => {
    const pkg = packages.find((node) => node.id === packageNodeId);
    const name = pkg?.variant ?? "this stakeholder";
    // Opened now, on the click, so the browser treats it as the person's
    // own; the upload takes longer than a popup blocker allows.
    const tab = how === "google" ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    setSaving((before) => new Set(before).add(packageNodeId));
    try {
      if (!pkg) throw new Error("That stakeholder's package could not be found.");
      const recorded = detail.nodes
        .filter((node) => node.kind === "audience_deck" && node.variant === pkg.variant && node.supersededByNodeId === null)
        .sort((a, b) => b.version - a.version)[0];
      const role = audiences.find((audience) => audience.name === pkg.variant)?.role ?? "";
      let theme = null;
      let themeNotice: string | null = null;
      if (role) {
        try {
          // The role's style guide, else the first PowerPoint among the
          // design documents that apply to this project (#246).
          theme = (await api.deckBrief(detail.project.id, role)).theme;
        } catch (cause) {
          themeNotice = `its design documents could not be read (${cause instanceof ApiFailure ? cause.detail.message : String(cause)}); using the default look`;
        }
      }
      const fileBase = deckFileName(detail.project.title, name).replace(/\.pptx$/, "");
      if (how === "pdf") {
        // Drawn from the same outline, design, theme and screens the preview shows.
        const packageContent = await api.artifactContent(tenantId, packageNodeId);
        const preferences = await api.deckDesigns();
        const deck = deckFrom({
          projectTitle: detail.project.title,
          audience: name,
          role,
          markdown: packageContent.content,
          design: deckDesignFor(role, preferences),
          ...(theme ? { theme } : {}),
        });
        if (!deck) throw new Error("its deck outline has no slides.");
        const shots = await designShots();
        printHtmlDocument(slidesPrintHtml(shots.length > 0 ? { ...deck, images: placeMockups(deck, shots) } : deck, fileBase));
      } else {
        let pptx: { dataUrl: string; filename: string };
        if (slidesSource({ hasRecordedDeck: Boolean(recorded), theme }) === "recorded" && recorded) {
          const result = await api.artifactContent(tenantId, recorded.id);
          pptx = { dataUrl: result.content, filename: `${recorded.title}.pptx` };
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
            ...(designHtml ? { mockup: { html: designHtml, shoot: () => designShots() } } : {}),
          });
          pptx = { dataUrl: built.dataUrl, filename: built.filename };
        }
        if (how === "google") {
          const opened = await openInGoogleSlides(pptx, fileBase, tab);
          if (opened.notice) toast(`Slides for ${name}: ${opened.notice}`);
        } else {
          downloadArtifact(pptx.dataUrl, pptx.filename);
        }
      }
      if (how === "google") {
        // Said above, when there was something to say.
      } else if (themeNotice) {
        toast(`Slides for ${name}: ${themeNotice}.`);
      }
      setSavedNodes((before) => new Set(before).add(packageNodeId));
    } catch (cause) {
      tab?.close();
      toast.error(`Slides for ${name}: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
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

  // The slides on screen, drawn from the same outline, design and style
  // guide theme `saveSlides` builds the file from, so what is shown is what
  // would be saved (#95). The designs are read once, a role's theme once per
  // role; a theme that cannot be read falls back to the default look and
  // says so, the way the download does.
  const designsRef = useRef<Promise<Record<string, unknown>> | null>(null);
  const themesRef = useRef(new Map<string, Promise<{ theme: TemplateTheme | null; failed: boolean }>>());
  const [preview, setPreview] = useState<{ deck: Deck; note: string | null } | { deck: null; note: string } | null>(null);
  // A string, not the stakeholder row: `audiences` is a fresh array every
  // render, and an effect keyed on it would rebuild the deck on every click.
  const previewRole = selected ? (audiences.find((audience) => audience.name === selected.variant)?.role ?? "") : "";
  useEffect(() => {
    if (!selected || !content) {
      setPreview(null);
      return;
    }
    const problem = packageOutlineProblem(content);
    if (problem) {
      setPreview({ deck: null, note: `No slides to show yet: ${problem}` });
      return;
    }
    const name = selected.variant ?? selected.title;
    const role = previewRole;
    let cancelled = false;
    void (async () => {
      designsRef.current ??= api.deckDesigns().then(
        (loaded) => loaded as Record<string, unknown>,
        () => ({}),
      );
      const preferences = await designsRef.current;
      let theme: TemplateTheme | null = null;
      let themeFailed = false;
      if (role) {
        if (!themesRef.current.has(role)) {
          themesRef.current.set(
            role,
            api.deckBrief(detail.project.id, role).then(
              (loaded) => ({ theme: loaded.theme, failed: false }),
              () => ({ theme: null, failed: true }),
            ),
          );
        }
        ({ theme, failed: themeFailed } = await themesRef.current.get(role)!);
      }
      if (cancelled) return;
      const design = deckDesignFor(role, preferences);
      const deck = deckFrom({
        projectTitle: detail.project.title,
        audience: name,
        role,
        markdown: content,
        design,
        ...(theme ? { theme } : {}),
      });
      if (!deck) {
        setPreview({ deck: null, note: "No slides to show yet: the deck outline has no slides." });
        return;
      }
      // The approved design's screens on the slides, as the file will carry them (#227).
      const shots = await designShots();
      if (cancelled) return;
      const pictured = shots.length > 0 ? { ...deck, images: placeMockups(deck, shots) } : deck;
      const notes = [
        themeFailed ? "Its design documents could not be read, so this is the default look." : null,
        design.images !== "none" ? "Pictures are drawn when the slides are saved." : null,
        designHtml && shots.length === 0 ? "The design's screens could not be captured for the slides." : null,
      ].filter((line): line is string => line !== null);
      setPreview({ deck: pictured, note: notes.length > 0 ? notes.join(" ") : null });
    })();
    return () => {
      cancelled = true;
    };
  }, [content, selected?.id, selected?.variant, selected?.title, previewRole, detail.project.title, designHtml, designRef]);

  // The votes are the workflow's own view (CL-8870), never re-derived here.
  // The tally and the gate they open live above the chat box (`AudienceGate`).
  const votesByAudience = workflowView?.audienceDecisions ?? {};
  // A vote cast on an earlier version of a stakeholder's package is neither
  // a proceed nor a block: the workflow lists it as stale and it needs a
  // new decision (#50).
  const staleVoters = new Set(workflowView?.stage5Quorum?.stale ?? []);

  const decide = async (node: (typeof packages)[number], decision: AudienceVote["decision"], note: string) => {
    if (!node.variant) return;
    try {
      // The vote names the package it was cast on -- this node, exactly --
      // so a rewrite afterwards leaves it stale rather than counted (#50).
      const reviewed = await packageRefOf(node, (nodeId) => api.artifactContent(tenantId, nodeId).then((result) => result.content));
      const result = await recordAudienceVote(audienceApprovalDeps, {
        projectId: detail.project.id,
        stage: workflowView?.stage ?? 5,
        audience: node.variant,
        decision,
        note: note.trim(),
        decisionId: `dec-${crypto.randomUUID()}`,
        package: reviewed,
      });
      if (!result.ok) {
        throw new ApiFailure({
          code: "conflict",
          message: `That decision was refused: ${stageRefusalMessage(result.reason)}`,
          correlationId: "-",
          retryable: true,
        });
      }
      setError(null);
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

  // The open package's own Proceed/Needs revision/Reject -- visible beside
  // the content a person is already reading, not behind a chip that has to
  // be found and clicked first (CL-8866: that hidden control was the only
  // place a decision actually recorded).
  const [inlineNote, setInlineNote] = useState("");
  const [inlineBusy, setInlineBusy] = useState<AudienceVote["decision"] | null>(null);
  useEffect(() => {
    setInlineNote("");
    setInlineBusy(null);
  }, [selected?.variant]);
  const recordInlineDecision = async (decision: AudienceVote["decision"]) => {
    if (!selected) return;
    setInlineBusy(decision);
    try {
      await decide(selected, decision, inlineNote);
      setInlineNote("");
    } catch {
      // decide() already surfaced the error via setError.
    } finally {
      setInlineBusy(null);
    }
  };
  const selectedVote = selected?.variant ? (votesByAudience[selected.variant] ?? null) : null;
  const selectedVoteStale = selected?.variant ? staleVoters.has(selected.variant) : false;

  return (
    <div data-tour="audience-packages">
      {error ? <Banner tone="error" title="That decision was refused">{error}</Banner> : null}
      {writeError ? <Banner tone="error" title="That package could not be written">{writeError}</Banner> : null}
      {audiences.length === 0 ? <Banner title="No stakeholders are named for this project" /> : null}

      <Stakeholders
        projectId={detail.project.id}
        audiences={audiences}
        quorum={quorum}
        onChanged={onChanged}
        {...(onStakeholdersSaved ? { onSaved: onStakeholdersSaved } : {})}
      />

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
                    Generate approval package
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
              Generate all {missing.length} packages
            </Button>
          ) : null}
        </div>
      ) : null}

      {packages.length > 0 ? (
        <>
          <QuorumChips
            audiences={audiences}
            packages={packages}
            votesByAudience={votesByAudience}
            staleVoters={staleVoters}
            onSelect={setActive}
            onDecide={(node, decision, note) => decide(node, decision, note)}
          />
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
                  <div className="document-tools">
                    <CopyButton text={content || null} />
                  </div>
                </div>
                {content ? <Markdown source={content} /> : <p className="inline-note">Loading…</p>}
              </div>
              {preview?.deck ? (
                <SlidePreview key={selected.id} deck={preview.deck} note={preview.note} />
              ) : preview ? (
                <p className="inline-note">{preview.note}</p>
              ) : null}
              {selected.variant ? (
                <div className="aud-decision" data-tour="audience-your-decision">
                  <p className="inline-note">
                    {selected.variant}:{" "}
                    {selectedVote && selectedVoteStale
                      ? `${DECISION_LABEL[selectedVote.decision]} on an earlier package · needs a new decision`
                      : selectedVote
                        ? DECISION_LABEL[selectedVote.decision]
                        : "no decision yet"}
                  </p>
                  <Input
                    value={inlineNote}
                    aria-label={`${selected.variant}'s note, optional`}
                    placeholder="Their note, optional"
                    onChange={(event) => setInlineNote(event.target.value)}
                  />
                  <div className="aud-btns">
                    <Button
                      variant="ghost"
                      loading={inlineBusy === "proceed"}
                      disabled={inlineBusy !== null}
                      onClick={() => void recordInlineDecision("proceed")}
                    >
                      Proceed
                    </Button>
                    <Button
                      variant="ghost"
                      loading={inlineBusy === "revise"}
                      disabled={inlineBusy !== null}
                      onClick={() => void recordInlineDecision("revise")}
                    >
                      Needs revision
                    </Button>
                    <Button
                      variant="ghost"
                      loading={inlineBusy === "reject"}
                      disabled={inlineBusy !== null}
                      onClick={() => void recordInlineDecision("reject")}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ) : null}
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
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="primary" loading={saving.has(selected.id)} doing={`Exporting ${selected.variant ?? selected.title}'s slides`}>
                      {saving.has(selected.id) ? "Exporting slides…" : "Export slides"}
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="start">
                    <MenuItem onSelect={() => void exportSlides(selected.id, "google")}>Open in Google Slides</MenuItem>
                    <MenuItem onSelect={() => void exportSlides(selected.id, "pptx")}>Save as PPTX</MenuItem>
                    <MenuItem onSelect={() => void exportSlides(selected.id, "pdf")}>Save as PDF</MenuItem>
                  </MenuContent>
                </Menu>
                {selected.variant ? (
                  <Button
                    loading={writing.has(selected.variant)}
                    disabled={writing.size > 0}
                    doing={packageWork(selected.variant)}
                    onClick={() => void writePackages([selected.variant!])}
                  >
                    {writing.has(selected.variant) ? "Writing…" : "Generate the package again"}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Stage 5's gate (#725), above the chat box like every other stage's: the
 * quorum tally and Approve and continue. The workflow's verdict is the only
 * gate, and `approveReasonText` the one translation of it. When the person
 * is the only stakeholder, the one click records their proceed and then
 * approves -- the two decisions the chip popover and this button would
 * otherwise take one at a time, in that order; the reducer still judges
 * each. With more stakeholders the button is held until the quorum is met.
 */
export function AudienceGate({
  detail,
  tenantId,
  workflowView,
  canApprove,
  approving,
  approveReason,
  lastRefusal,
  onApprove,
  onChanged,
}: {
  detail: ProjectDetail;
  tenantId: string;
  workflowView: ProjectWorkflowView | null;
  /** `allowed.approve`: a review is open. The quorum is judged separately below. */
  canApprove: boolean;
  approving: boolean;
  approveReason: ApproveReason | null;
  lastRefusal: DecisionRecord | null;
  onApprove: () => void;
  onChanged: () => void;
}) {
  const [proceeding, setProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = (detail.project.policy ?? {}) as Policy;
  const audiences = youFirst(policy.audiences ?? []);
  const packages = packagesByStakeholder(detail.nodes, audiences);
  if (packages.length === 0) return null;

  // Before a review has opened `stage5Quorum` is null, so the count falls
  // back to the policy's own quorum, the "must proceed" the editor shows.
  const requiredQuorum = workflowView?.stage5Quorum?.required ?? policy.audienceQuorum ?? 0;
  const proceeded = workflowView?.stage5Quorum?.proceeded ?? 0;
  const blockedBy = workflowView?.stage5Quorum?.blocked ?? [];
  const staleBy = workflowView?.stage5Quorum?.stale ?? [];
  const quorumMet = workflowView?.stage5Quorum?.met === true;
  const solo = audiences.length === 1 && isYou(audiences[0]!) && requiredQuorum <= 1;
  const waiting = Math.max(requiredQuorum - proceeded, 0);
  const reason =
    (approveReason ? approveReasonText(approveReason, lastRefusal) : null) ??
    (quorumMet
      ? null
      : blockedBy.length > 0
        ? `${blockedBy.join(" and ")} ${blockedBy.length === 1 ? "has" : "have"} blocked this.`
        : staleBy.length > 0
          ? `${staleBy.join(" and ")} decided on an earlier package and ${staleBy.length === 1 ? "needs" : "need"} to decide again.`
          : `Waiting for ${waiting} stakeholder${waiting === 1 ? "" : "s"} to proceed.`);

  const proceedAndApprove = async () => {
    const own = packages[0]!;
    if (!own.variant) return;
    setProceeding(true);
    setError(null);
    try {
      if (!quorumMet) {
        const reviewed = await packageRefOf(own, (nodeId) => api.artifactContent(tenantId, nodeId).then((result) => result.content));
        const result = await recordAudienceVote(audienceApprovalDeps, {
          projectId: detail.project.id,
          stage: workflowView?.stage ?? 5,
          audience: own.variant,
          decision: "proceed",
          note: "",
          decisionId: `dec-${crypto.randomUUID()}`,
          package: reviewed,
        });
        if (!result.ok) throw new Error(`That decision was refused: ${stageRefusalMessage(result.reason)}`);
        onChanged();
      }
      onApprove();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProceeding(false);
    }
  };

  return (
    <div className="stage-action composer-approve">
      <span className="composer-approve-lead">
        <span>{solo ? "You're the only stakeholder. Happy with it?" : requiredQuorum > 0 ? `${proceeded} of ${requiredQuorum} have proceeded.` : "Happy with it?"}</span>
        {!solo && reason ? <span>{reason}</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </span>
      <span className="approve">
        <Button
          variant="ghost"
          loading={approving || proceeding}
          disabled={!canApprove || (!solo && !quorumMet)}
          onClick={solo ? () => void proceedAndApprove() : onApprove}
        >
          <Check aria-hidden="true" />
          Approve and continue
        </Button>
      </span>
    </div>
  );
}
