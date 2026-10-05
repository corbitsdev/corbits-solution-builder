/**
 * The stage workspace.
 *
 * A stage is a document someone has to read and react to, so the document is
 * the page. Before one exists there is a single question and nothing else;
 * once one exists the draft box is gone and the document takes the room, with
 * the conversation that produced it alongside.
 *
 * Reacting to a document means saying what is wrong with a specific part of
 * it, so selecting text in the document opens a comment on that passage.
 * Comments queue rather than sending one at a time — a reader marks up a whole
 * draft and then hands it back, which is both how people actually read and the
 * only way the specialist sees the notes as one coherent set.
 *
 * The file itself is orchestration only: each stateful concern lives in a
 * `use-*.ts` hook beside it (workflow view, specialist, thread, withdrawn
 * turns, opening dispatch, advisories, document versions, gate decisions),
 * and each render block a focused component (`workspace-chrome.tsx`). What
 * stays here is the wiring between them and the stage-specific composition.
 */
import { toast } from "sonner";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiFailure,
  type ArtifactNode,
  type ProjectDetail,
  type Provider,
  type StageTurn,
} from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { Markdown } from "../../markdown.jsx";
import { BinaryFile, isDataUrl } from "../../binary-file.tsx";
import { AudienceGate, AudiencePackages } from "../audiences.jsx";
import { DesignFeedbackView } from "../design.jsx";
import { Tabs } from "@corbits/react-ui";
import { Banner, Button, CopyButton, GuideDock, Screen, StateLabel, documentName, stageName, versionDigest } from "../../components.jsx";
import { useBusyWhile } from "../../use-busy.ts";
import { DesignFrames, FrameSelect, framedDesign, type FrameMode } from "../../design-frames.tsx";
import { specialistActivity } from "./specialist-activity.ts";
import { DeliveryPanel } from "./delivery.jsx";
import { StageConversation } from "./thread.jsx";
import { StageDocument } from "./document.jsx";
import { BuildPanel } from "./build.jsx";
import { useBuildAttempts } from "./build-attempts.ts";
import { TargetPicker } from "./freeze.jsx";
import { EstimateView } from "./estimate.jsx";
import { interviewProgress, isHtmlDocument, latestDesignReply, workspaceGuidance } from "./guidance.js";
import { repairedChoiceDraft } from "./choice-repair.ts";
import { repairedStackDraft } from "./stack-repair.ts";
import { revisionRequest } from "@solutions-builder/app/stage-prompt";
import { draftReferences } from "./draft-references.ts";
import { designHistory } from "./design-history.ts";
import { ArrowLeft, Check, Flame, Send, Undo2 } from "lucide-react";
import { useWorkflowView } from "./use-workflow-view.ts";
import { useStageAgent } from "./use-stage-agent.ts";
import { useStageThread } from "./use-stage-thread.ts";
import { useWithdrawnTurns } from "./use-withdrawn-turns.ts";
import { useSpecialistRunState } from "./use-specialist-run-state.ts";
import { specialistBusy } from "../../specialist-run-state.ts";
import { useOpeningDispatch } from "./use-opening-dispatch.ts";
import { useMaterialDispatch } from "./use-material-dispatch.ts";
import { splitMaterialMail } from "./attached-material.ts";
import { isComposedOpening } from "./composed-mail.ts";
import { useProductGuide, useStageEvaluator } from "./use-advisory.ts";
import { guideStep } from "./product-guide.ts";
import { useProjectArtifacts } from "./use-project-artifacts.ts";
import { loadQuotedDraft } from "./quote-store.js";
import { useStageDecisions } from "./use-stage-decisions.ts";
import { composeSendBackReason } from "./send-back-reason.ts";
import { useRecordedDeck } from "./deck-reader.jsx";
import { DocumentExportMenu } from "../../document-export.jsx";
import { SlidePreview } from "../../slide-preview.jsx";
import { ArtifactStrip, VersionSelect } from "./artifact-strip.tsx";
import { cueEvents, stageEvents, switchEvents, type StageEvent } from "./stage-events.ts";
import { sendBackCueIdOf } from "./send-back-cue.ts";
import { useModelSwitch, useModelHandoff } from "./use-model-handoff.ts";
import { currentInference, inferenceOptions, orderLeadingWith, type InferenceOption } from "./inference-options.ts";
import { loadDismissedDefault, saveDismissedDefault } from "./model-nudge-store.ts";
import { Stage6Panel } from "./stage6.tsx";
import { PanelReviewsCompanion, reviewNodesOf as panelReviewNodesOf } from "./panel-reviews.tsx";
import { renderStackBlock } from "./frozen-stack-text.ts";
import { documentAsMessage, requirementsDocument, reviewDocument, withAttachedDocuments, type StageDocument as MentionedDocument } from "./document-mentions.ts";
import { askKind, delegationTarget, requirementsRequest, routedLine } from "./message-intent.ts";
import { TERMINAL_RUN_NOTICE, isTerminalRunRefusal } from "./terminal-run.ts";

/** Stage 6's recorded panel reviews, newest unsuperseded version per reviewer (#334). */
function reviewNodesOf(nodes: readonly ArtifactNode[]): ReadonlyMap<string, ArtifactNode> {
  const byReviewer = new Map<string, ArtifactNode>();
  for (const node of nodes) {
    if (node.kind !== "engineering_review" || node.stage !== 6 || node.supersededByNodeId !== null || !node.variant) continue;
    const held = byReviewer.get(node.variant);
    if (!held || node.version > held.version) byReviewer.set(node.variant, node);
  }
  return byReviewer;
}
import { renderRequirementsBlock } from "@solutions-builder/app/requirements";
import { agentFor } from "@solutions-builder/app/kit";
import type { Stage } from "@solutions-builder/app/ledger";
import { STAGE_DRAFT_KIND } from "../../client.js";
import { PRD_FOR_PEOPLE_KIND } from "../../prd-for-people.ts";
import { useProjectDesignPictures, usePrdForPeople } from "./use-prd-for-people.ts";
import {
  EvaluatorStance,
  OpeningScreen,
  SendBackConfirm,
  SendBackPopover,
  StagePanes,
} from "./workspace-chrome.tsx";
import type { FoldedFeedback } from "@solutions-builder/app/design-prompt";

export { StageDocument, DocumentBody } from "./document.jsx";
export { ApprovalsRecord, STAGE_GOAL } from "./gate.jsx";

/** Stages whose draft is prose read in the two-pane document, rather than
 * one of the specialised panels (design, audiences, build) or the final
 * decisions stage. */
const DOCUMENT_STAGES = new Set([1, 2, 3, 6, 7]);

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

export function StageWorkspace({
  detail,
  tenantId,
  onChanged,
  onOpenSettings,
  draftOpen = true,
  onOpenDecisions,
  focusArtifact,
  onViewedStage,
}: {
  detail: ProjectDetail;
  /**
   * Accepted for compatibility with callers still on the pre-mail-chat
   * shape; unused here — the mail-chat contract (CL-8612) has no lifecycle
   * run to fold a position from, no draft/versions split, and stage 9's
   * decisions live entirely in the existing approvals UI, not this page.
   */
  standing?: unknown;
  draftOpen?: boolean;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  onOpenSettings: () => void;
  onOpenDecisions?: () => void;
  /** A done-segment click: open that stage's newest artifact tab. `at` makes
   *  a repeat click on the same stage a fresh signal. */
  focusArtifact?: { readonly stage: number; readonly at: number };
  /** Reports which stage's document is on screen when it is not this
   *  stage's own (null otherwise), so the top bar can mark it. */
  onViewedStage?: (stage: number | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<
    import("../../client.js").Remediation | undefined
  >(undefined);

  // A brand-new project's own opening statement — real content for the
  // opening screen's "before the first reply" chrome, read the same way
  // `api.projectOpening` always has (the `source_material`/opening artifact
  // `createProject` wrote), never simulated. Null once read resolves with
  // nothing recorded; undefined while still loading.
  const [openingStatement, setOpeningStatement] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setOpeningStatement(undefined);
    void api
      .projectOpening(detail.project.id)
      .then((result) => {
        if (!cancelled) setOpeningStatement(result?.body ?? null);
      })
      .catch(() => {
        if (!cancelled) setOpeningStatement(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id]);

  // The opening screen's own current-stage draft content — read the same
  // way `ProductRequirements` reads a single node's content below, off the
  // artifact fold already on `detail.nodes` rather than the mail thread, so
  // it renders before the stage specialist (and its mailbox) exist at all.
  const [openingDraftNodeId, setOpeningDraftNodeId] = useState<string | null>(null);
  const [openingDraftContent, setOpeningDraftContent] = useState<string | null>(null);
  useEffect(() => {
    if (!openingDraftNodeId) {
      setOpeningDraftContent(null);
      return;
    }
    let cancelled = false;
    setOpeningDraftContent(null);
    void api
      .artifactContent(tenantId, openingDraftNodeId)
      .then((result) => {
        if (!cancelled) setOpeningDraftContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setOpeningDraftContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
  }, [openingDraftNodeId, tenantId]);

  const workflow = useWorkflowView(detail.project.id, onChanged);
  const workflowView = workflow.view;
  const workflowResolved = workflow.resolved;
  const openingFailed = workflow.openingFailed;
  const stage = workflowView?.stage ?? 1;

  // `detail.stage` was already resolved by the same non-deploying read
  // (`resolveProjectWorkflowRef`/`findProjectWorkflow`, via `project-view.ts`'s
  // `workflowStage`) when this project's detail loaded — it is 1 only when no
  // workflow ref exists yet for this project, never a guess: any other value
  // can only come from a ref that actually resolved. A stage of 1 on a
  // project that already has nodes stays ambiguous (that same fallback is
  // also what a failed ref lookup collapses to), so the early start is
  // withheld there. This lets the stage specialist begin deploying
  // concurrently with `ensureProjectWorkflow`'s own ensure/poll cycle
  // instead of serially after it, without ever guessing a stage for a
  // project with history.
  const confirmedStage = detail.stage > 1 || detail.nodes.length === 0 ? detail.stage : null;

  const agent = useStageAgent(detail.project.id, stage, workflowResolved, confirmedStage);
  const agentAddress = agent.address;
  // Stable across renders — an inline arrow would re-subscribe the mailbox
  // stream every render since it is a dep of the thread effect.
  const nudgeWorkflow = useCallback(() => void workflow.reload(), [workflow.reload]);
  const thread = useStageThread(tenantId, agentAddress, agent.addresses, nudgeWorkflow, setError);
  const loadThread = thread.reload;

  // What Stop put back into the box: the composer below for a plain-chat
  // stage, and this seed for the document composer's own local state.
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [stopSeed, setStopSeed] = useState<{ text: string; at: number } | null>(null);
  // How a design read here is framed: phone screens in iPhones, or the pane (#101).
  const [frameMode, setFrameMode] = useState<FrameMode>("auto");

  const withdrawn = useWithdrawnTurns(
    detail.project.id,
    tenantId,
    stage,
    detail.nodes,
    thread.messages,
    (stopped) => {
      // A stopped material mail (#607) is not something the person typed:
      // nothing of it goes back into the box.
      const body = splitMaterialMail(stopped) ? "" : stopped;
      setComposer(body);
      setStopSeed({ text: body, at: Date.now() });
    },
    setError,
  );
  const foldedMessages = withdrawn.messages;
  // What the transcript shows (#723): the stage's composed opening is mail
  // for the specialist, not a turn of the person's. Everything that reasons
  // over the thread still reads `foldedMessages`, opening included.
  const shownMessages = useMemo(() => foldedMessages.filter((message) => !isComposedOpening(message)), [foldedMessages]);
  const withdrawnIds = withdrawn.ids;
  const pending = withdrawn.pending;
  const stopTurn = withdrawn.stop;
  // Whether the specialist is working comes from its run (#445); the mailbox
  // (a person turn with no reply) speaks only when the run cannot be read.
  const threadKey = `${String(foldedMessages.length)}:${foldedMessages.at(-1)?.id ?? ""}`;
  const runState = useSpecialistRunState(detail.project.id, stage, agentAddress, pending !== null, threadKey);
  const busy = specialistBusy(runState, pending?.at ?? null);
  // A specialist turn in flight is the longest wait in the product; the
  // busy indicator at the foot of the window counts it alongside the flame.
  // A composed opening is mail the app wrote, not words of the person's to
  // read an ask off: the specialist is drafting, whatever the mail says.
  const pendingAsk = pending && isComposedOpening(pending) ? "draft" : askKind(pending?.body ?? null, foldedMessages.some((message) => message.author === "agent"));
  useBusyWhile(busy, specialistActivity(stage, pendingAsk));

  const openingDispatch = useOpeningDispatch({
    detail,
    tenantId,
    stage,
    agentAddress,
    addresses: agent.addresses,
    messages: thread.messages,
    loadedFor: thread.loadedFor,
    workflowView,
    reloadThread: loadThread,
  });

  // Withdrawn turns are folded out before anything below reads the thread,
  // so a reply Stop hid can never surface as the latest turn, the draft, or
  // the open question (CL-8695).
  const latestSpecialistMessage = [...foldedMessages].reverse().find((message) => message.author === "agent") ?? null;
  // Mail has no separate draft record before approval. Keep a substantial
  // draft separate from the latest conversational turn so an acknowledgement
  // or a follow-up question never replaces the document being reviewed.
  const guidance = useMemo(() => workspaceGuidance(stage, foldedMessages), [stage, foldedMessages]);
  // A stage 3 draft that absorbed the person's choice anywhere but under
  // "## Chosen approach" would leave them choosing again (#430): the
  // section is written in deterministically, as alpha main did, before the
  // pane or the gate reads the draft.
  // A stage 6 revision that dropped the plan's Stack block gets the last
  // valid one carried in (#437), so the gate's banner is for a plan that
  // never had one.
  const draftMessage = useMemo(
    () => repairedStackDraft(stage, foldedMessages, repairedChoiceDraft(stage, foldedMessages, guidance.draft)),
    [stage, foldedMessages, guidance.draft],
  );

  // Stage 1's brief evaluator reads each new draft; the Product guide answers
  // when asked, on any stage. Both are advisory and never touch the gate.
  const evaluator = useStageEvaluator(detail.project.id, tenantId, stage, draftMessage);
  const guideContext = {
    projectTitle: detail.project.title,
    stage,
    view: workflowView,
    nodes: detail.nodes,
    soloApproval: detail.soloApproval,
  };
  const guide = useProductGuide(tenantId, detail.project.id, guideContext);
  // Stage 4's reviewable material is a design reply and nothing else: the
  // designer's contract is one self-contained HTML document per design, so
  // an error, a question or an acknowledgement is conversation, never a
  // version to open a review on (#81). Every stage also waits for the thread
  // to have loaded for this stage's own specialist -- at a stage transition
  // the previous stage's messages linger for a few renders, and a review
  // opened off them would persist the previous stage's document as this
  // stage's first draft.
  const threadLoaded = thread.loadedFor !== null && thread.loadedFor === agentAddress;
  useBusyWhile(!threadLoaded, "Opening the conversation");
  const latestDesign = useMemo(() => latestDesignReply(foldedMessages), [foldedMessages]);
  const reviewMessage = !threadLoaded ? null : DOCUMENT_STAGES.has(stage) ? draftMessage : stage === 4 ? latestDesign : latestSpecialistMessage;
  const progress = useMemo(() => interviewProgress(foldedMessages), [foldedMessages]);

  // Mail turns as StageDocument's turn shape: it wants who spoke and what
  // was said, nothing this contract tracks beyond that (no per-turn quotes
  // or result-node bookkeeping under mail-chat).
  // A send-back cue is shown as its event line (`cueEvents`), not as a turn,
  // and the composed opening is not shown at all (#723).
  const turns: StageTurn[] = useMemo(
    () =>
      shownMessages.filter((message) => !(message.author === "me" && sendBackCueIdOf(message.subject))).map((message) => ({
        id: message.id,
        role: message.author === "me" ? "human" : "specialist",
        body: message.body,
        quotes: [],
        resultNodeId: null,
        questions: null,
        createdAt: message.at,
      })),
    [shownMessages],
  );

  const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
  const artifacts = useProjectArtifacts(tenantId, stage, detail.nodes, draftMessage);
  // Each draft reply's version (#158): the conversation shows the reply as a
  // line naming it, on every document stage and on a reload alike, since
  // both the mail and the lineage are records.
  const liveVersions = artifacts.tabs.find((tab) => tab.live)?.versions;
  const draftRefs = useMemo(
    () =>
      DOCUMENT_STAGES.has(stage) && draftKind
        ? draftReferences(foldedMessages, liveVersions ?? [], documentName(draftKind).toLowerCase())
        : undefined,
    [stage, draftKind, foldedMessages, liveVersions],
  );
  // A done-segment click is a navigation signal, not state — one effect is
  // where it lands.
  useEffect(() => {
    if (focusArtifact) artifacts.selectStage(focusArtifact.stage);
    // `at` is the nonce; the tabs/artifacts identity is intentionally out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusArtifact?.at]);
  // Which stage's document is on screen, reported up for the stepper: a
  // past stage opened from the track, or null for this stage's own work.
  const viewedStage = artifacts.selected !== null && artifacts.selected.stage !== stage ? artifacts.selected.stage : null;
  useEffect(() => {
    onViewedStage?.(viewedStage);
    return () => onViewedStage?.(null);
  }, [viewedStage, onViewedStage]);

  // The transcript's quiet record: boundaries, versions, decisions, aborted
  // turns and a model switch's own announcement, folded in beside the mail
  // as system lines.
  // Messages this session routed to the requirements author instead of the
  // architect (#407): a line in the chat says so, where the message would
  // have been.
  const [routedEvents, setRoutedEvents] = useState<StageEvent[]>([]);
  const [requirementsAsk, setRequirementsAsk] = useState<{ body: string; at: number } | null>(null);
  useEffect(() => {
    setRoutedEvents([]);
    setRequirementsAsk(null);
  }, [stage, detail.project.id]);
  const events = useMemo(
    () => [
      ...stageEvents(stage, workflowView?.decisions ?? [], detail.nodes, withdrawn.marks),
      ...switchEvents(foldedMessages),
      ...cueEvents(foldedMessages),
      ...routedEvents,
    ],
    [stage, workflowView?.decisions, detail.nodes, withdrawn.marks, foldedMessages, routedEvents],
  );

  // CL-8899: the current stage's provider/model, reporting-only (read off
  // the live deployment's pinned source, `resolveActiveModel`) — refetched
  // whenever the live address moves, since that's exactly when a new pin
  // has landed, whether from an explicit switch or any other redeploy.
  const [activeModel, setActiveModel] = useState<{ providerLabel: string; canonicalName: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.activeModel(detail.project.id, stage).then((model) => {
      if (!cancelled) setActiveModel(model);
    });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id, stage, agentAddress]);

  // The Inference picker: Settings' provider-and-model rows, in Settings'
  // order (`inference-options.ts`). Fetched once the specialist exists and
  // again after a pick, since a pick reorders those rows.
  const [inferenceProviders, setInferenceProviders] = useState<Provider[] | null>(null);
  const [inferenceNonce, setInferenceNonce] = useState(0);
  useEffect(() => {
    if (!agentAddress) return;
    let cancelled = false;
    void api.providers().then((result) => {
      if (!cancelled) setInferenceProviders(result.providers);
    });
    return () => {
      cancelled = true;
    };
  }, [agentAddress, inferenceNonce]);
  const inferenceChoices = inferenceOptions(inferenceProviders ?? []);
  const runningInference = currentInference(activeModel, inferenceChoices);

  const modelSwitch = useModelSwitch({ projectId: detail.project.id, stage });
  // Choosing an inference is the same as dragging its row to the top in
  // Settings -- it becomes the default -- and this stage switches onto it.
  const pickInference = async (option: InferenceOption) => {
    if (!inferenceProviders) return;
    await api.reorderProviders(orderLeadingWith(inferenceProviders, option.providerRowId));
    setInferenceNonce((nonce) => nonce + 1);
    setWorkspaceDefaultModel({ providerLabel: option.providerLabel, canonicalName: option.model });
    await modelSwitch.switchTo(option.offeringId);
  };

  // The owner's ask: opening a project whose current stage is running a
  // model other than the workspace's current default should offer, not
  // force, catching it up -- never a redeploy the person did not choose.
  // `workspaceDefaultModel` is unscoped (`api.activeModel()`, no
  // projectId/stage), the same "lowest-priority offering" read Settings'
  // own default row uses, so this nudge and the deploy path always agree on
  // what "the default" means. Dismissing records the default's OWN name
  // (`model-nudge-store.ts`), so a later default change asks again rather
  // than staying quiet forever.
  const [workspaceDefaultModel, setWorkspaceDefaultModel] = useState<{ providerLabel: string; canonicalName: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.activeModel().then((model) => {
      if (!cancelled) setWorkspaceDefaultModel(model);
    });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id]);
  const [nudgeDismissedFor, setNudgeDismissedFor] = useState<string | null>(null);
  useEffect(() => {
    setNudgeDismissedFor(loadDismissedDefault(detail.project.id, stage));
  }, [detail.project.id, stage]);
  // The default is Settings' top row: the first inference option.
  const defaultOffering = inferenceChoices[0] ?? undefined;
  const modelNudgeVisible =
    !!agentAddress &&
    !!activeModel &&
    !!workspaceDefaultModel &&
    !!defaultOffering &&
    activeModel.canonicalName !== workspaceDefaultModel.canonicalName &&
    nudgeDismissedFor !== workspaceDefaultModel.canonicalName;
  const dismissModelNudge = () => {
    if (!workspaceDefaultModel) return;
    saveDismissedDefault(detail.project.id, stage, workspaceDefaultModel.canonicalName);
    setNudgeDismissedFor(workspaceDefaultModel.canonicalName);
  };
  // Fires the hand-off for ANY redeploy of a stage that already has mail
  // under a prior address — an explicit switch (above) or any other cause
  // (restart, recovery) — never for a brand-new stage (CL-8927's own opening
  // dispatch handles that).
  const modelHandoff = useModelHandoff({
    tenantId,
    address: agentAddress,
    addresses: agent.addresses,
    unionMessages: foldedMessages,
    threadLoaded,
    draft: draftMessage,
    providerLabel: activeModel?.providerLabel ?? null,
    modelName: activeModel?.canonicalName ?? null,
    reloadThread: loadThread,
  });
  // Stage 8's attempts live on the host (`apps/hub/src/build-attempts.ts`);
  // the panel drives them and the gate reads whether the recorded archive
  // is the current attempt's.
  const builds = useBuildAttempts(detail.project.id, stage === 8);
  const decisions = useStageDecisions({
    detail,
    tenantId,
    stage,
    workflowView,
    reviewMessage,
    draftKind,
    foldedMessages,
    buildAttempts: builds.attempts,
    buildAttemptsLoaded: builds.loaded,
    refreshWorkflow: workflow.refresh,
    markStage: workflow.markStage,
    queueOpening: openingDispatch.queueOpening,
    onError: setError,
    onRemediation: setRemediation,
    onDetailChanged: onChanged,
    onRequirementsReminted: (block) =>
      void send(
        `The requirements document was revised and the requirement ids were re-issued from it. Cite these ids in the plan from now on; a number from an earlier version may now mean something else.\n\n${block}`,
      ),
  });
  const {
    approve,
    acceptDelivery,
    approveAllowed,
    approving,
    openReviewNow,
    chosenTarget,
    setChosenTarget,
    sendBack,
    setSendReason,
    mintRequirements,
  } = decisions;
  const refreshWorkflow = workflow.refresh;

  // Holding send raises the send-back picker over the composer; whatever is
  // typed goes along as the reason. The full picker also lives in Guidance —
  // a hold gesture is invisible to keyboard and discovery both.
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const openSendBack = (draft: string) => {
    // Queued passages lead the reason — the send-back is what they were
    // attached for, so they go whether or not a note was typed.
    const reason = composeSendBackReason(loadQuotedDraft(tenantId, stage), draft);
    if (reason) setSendReason(reason);
    setSendBackOpen(true);
  };
  // A recorded stakeholder deck opened from the strip (#249): its slides
  // drawn again from its package, with stage 5's export menu, rather than
  // a bare file card. No-op unless the open document is such a deck.
  const readerDeckNode =
    artifacts.selected !== null && artifacts.selected.stage !== stage && artifacts.activeNode?.kind === "audience_deck" ? artifacts.activeNode : null;
  const designReview = workflowView?.reviews[4];
  const recordedDeck = useRecordedDeck({
    node: readerDeckNode,
    nodes: detail.nodes,
    tenantId,
    projectId: detail.project.id,
    projectTitle: detail.project.title,
    audiences: ((detail.project.policy ?? {}) as { audiences?: { name: string; role: string }[] }).audiences ?? [],
    designRef: designReview?.status === "approved" ? designReview.artifactId : null,
    content: artifacts.activeContent,
  });
  // The reader's own send-back (#248): a confirm beside its button, naming
  // the one stage the open document belongs to, never the composer's picker.
  const [readerSendBack, setReaderSendBack] = useState(false);
  useEffect(() => {
    setReaderSendBack(false);
  }, [artifacts.selected?.key]);
  const sendBackPopover = (
    <SendBackPopover
      stage={stage}
      open={sendBackOpen}
      onDismiss={() => setSendBackOpen(false)}
      onPick={(target) => {
        setSendBackOpen(false);
        void sendBack(target);
      }}
    />
  );

  // Reading a superseded version of the stage's draft: the gate swaps
  // approve for "make this the active version" — restoring writes the old
  // content forward as the new head, versions are append-only.
  const [promoting, setPromoting] = useState(false);
  const superseded =
    artifacts.isStageDraft && artifacts.selected !== null && artifacts.activeNode !== null &&
    artifacts.activeNode !== artifacts.selected.versions.at(-1);
  const promote = async () => {
    if (!artifacts.activeContent || !superseded) return;
    setPromoting(true);
    try {
      const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
      await api.persistStageDraft(detail.project.id, stage, artifacts.activeContent, materials);
      await refreshWorkflow();
      artifacts.select(null);
    } catch (cause) {
      toast.error(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setPromoting(false);
    }
  };

  // The stage's companion documents (#345): named in a message, they go along with it.
  const [stageDocuments, setStageDocuments] = useState<MentionedDocument[]>([]);
  // The PRD for people (#740) is kept current at every stage: written when
  // it is missing or older than the PRD or the design, and never otherwise.
  const prdForPeople = usePrdForPeople({ projectId: detail.project.id, tenantId, nodes: detail.nodes, approvedInputs: openingDispatch.stage6Material, onDocumentsChanged: onChanged });
  // Its pictures, for reading it from the strip at any stage.
  const peoplePictures = useProjectDesignPictures(tenantId, detail.nodes, artifacts.activeNode?.kind === PRD_FOR_PEOPLE_KIND);
  useEffect(() => {
    setStageDocuments([]);
  }, [stage, detail.project.id]);

  const addMaterial = async (files: File[]) => {
    try {
      await api.attachMaterial(detail.project.id, files);
      void refreshWorkflow();
    } catch (cause) {
      toast.error(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };
  // A file attached once the stage has opened is mailed to its specialist
  // (#607): the opening that would have carried it has already gone. The
  // refresh above is what brings the new file into `detail.nodes`.
  const materialDispatch = useMaterialDispatch({
    tenantId,
    stage,
    nodes: detail.nodes,
    agentAddress,
    addresses: agent.addresses,
    messages: thread.messages,
    loadedFor: thread.loadedFor,
    busy: busy || sending,
    revising: draftMessage && stage <= 7 && !isHtmlDocument(draftMessage.body) ? draftMessage.body : null,
    reloadThread: loadThread,
  });
  // Said where a refused attachment is said: the file is kept, and the
  // specialist has not been sent it.
  const attachNote =
    (materialDispatch.error
      ? `The attached material is saved, and could not be sent to the ${stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title.toLowerCase() : "specialist"}: ${materialDispatch.error}`
      : null);

  // A delegation in flight (#688): who is working, for the busy strip.
  const [delegating, setDelegating] = useState<string | null>(null);
  useBusyWhile(delegating !== null, delegating ?? "");
  const routedLineFor = (text: string) => {
    const at = new Date().toISOString();
    setRoutedEvents((prev) => [...prev, { id: `ev:routed:${String(prev.length)}`, at, text, tone: "line" }]);
  };
  const delegate = async (targetStage: number, body: string) => {
    const who = agentFor(targetStage as Stage).title;
    const kind = STAGE_DRAFT_KIND[targetStage];
    const docName = kind ? documentName(kind) : stageName(targetStage);
    routedLineFor(`"${body.trim().slice(0, 80)}" — sent to the ${who}, whose document the ${docName} is; the reply becomes its next version under ${stageName(targetStage)}.`);
    setDelegating(`${who} is revising the ${docName}`);
    setError(null);
    try {
      const deployment = await api.ensureStageAgent(detail.project.id, targetStage);
      const current = kind
        ? detail.nodes
            .filter((node) => node.kind === kind && node.stage === targetStage && node.variant === null && node.supersededByNodeId === null)
            .sort((a, b) => b.version - a.version)[0]
        : undefined;
      const currentText = current ? (await api.artifactContent(tenantId, current.id)).content : "";
      const mail = currentText
        ? `${body.trim()}\n\n---\n\n## Attached: the current ${docName} (revise this; keep everything not asked to change, and reply with the whole revised document)\n\n${currentText}`
        : body.trim();
      const before = new Set((await api.readStageThread(tenantId, [deployment.address])).map((message) => message.id));
      const requestedAt = Date.now();
      await api.sendStageMail(tenantId, deployment.address, { body: mail });
      const deadline = Date.now() + 15 * 60_000;
      let reply: ChatMessage | undefined;
      while (!reply && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const thread = await api.readStageThread(tenantId, [deployment.address]);
        reply = thread.find((message) => message.author === "agent" && !before.has(message.id) && Date.parse(message.at) >= requestedAt - 60_000);
      }
      if (!reply) throw new Error(`The ${who} has not replied yet; its reply will be under ${stageName(targetStage)} when it does.`);
      if (kind) {
        await api.persistStageDraft(detail.project.id, targetStage, reply.body);
        onChanged();
        const approvedBefore = targetStage < stage;
        routedLineFor(
          `${who} revised the ${docName}; it is recorded as the newest version under ${stageName(targetStage)}.${approvedBefore ? ` The build keeps using the approved version until ${stageName(targetStage)} is approved again (send the project back to it when you are happy with the change).` : ""}`,
        );
      } else {
        routedLineFor(`${who} replied under ${stageName(targetStage)}.`);
      }
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDelegating(null);
    }
  };

  const send = async (body: string) => {
    if (!agentAddress || body.trim().length === 0) return;
    // A requirements request is the requirements author's (#407): it
    // goes to the companion's author with any named review attached, and
    // the chat says so where the message would have been.
    if (stage === 6 && requirementsRequest(body)) {
      const at = new Date().toISOString();
      setRequirementsAsk({ body, at: Date.now() });
      setRoutedEvents((prev) => [...prev, { id: `ev:routed:${String(prev.length)}`, at, text: `"${body.trim().slice(0, 80)}" — ${routedLine()}`, tone: "line" }]);
      return;
    }
    // Work asked of another stage's specialist by name (#688) goes to that
    // specialist, with its current document attached; the reply is recorded
    // as that stage's next version and the chat says where it went.
    const target = delegationTarget(body, stage);
    if (target) {
      void delegate(target.stage, body);
      return;
    }
    setSending(true);
    setError(null);
    setRemediation(undefined);
    try {
      // With a Markdown draft on the table, the turn carries it and the
      // instruction to revise it, as alpha main's rounds did (#431); a design
      // (HTML) has its own feedback path, and stages 8 and 9 revise nothing.
      const revising = draftMessage && stage <= 7 && !isHtmlDocument(draftMessage.body);
      const turn = withAttachedDocuments(body, stageDocuments);
      const mail = revising ? revisionRequest({ stage, userInput: turn, currentDocument: draftMessage.body }) : turn;
      await api.sendStageMail(tenantId, agentAddress, { body: mail });
      await loadThread();
    } catch (cause) {
      if (isTerminalRunRefusal(cause)) {
        // The specialist's run has ended (#413): ask for it again, which
        // drops the dead deployment and places a fresh one, refresh the live
        // address, and hand the message back. The redeploy hand-off carries
        // the conversation to the new specialist before it is sent again.
        setComposer(body);
        setError(TERMINAL_RUN_NOTICE);
        void api
          .ensureStageAgent(detail.project.id, stage)
          .then(() => agent.retry())
          .catch((again: unknown) => setError(again instanceof ApiFailure ? again.detail.message : String(again)));
        return;
      }
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setSending(false);
    }
  };

  // Only a stage whose specialist has run before is reconnected to.
  const resuming = agent.addresses.length > 0;

  // The confirmed current stage for the opening screen's own reads: the
  // resolved workflow stage once known, else the same non-deploying
  // `detail.stage` confirmation `use-stage-agent.ts`'s early start trusts —
  // never the unresolved `stage` fallback (`workflowView?.stage ?? 1`),
  // which would show a resuming project's draft under the wrong stage while
  // the workflow view is still catching up.
  const openingStage = workflowResolved ? stage : detail.stage;
  const openingDraftKind = STAGE_DRAFT_KIND[openingStage] ?? null;
  const openingDraftNode =
    openingDraftKind !== null
      ? (detail.nodes
          .filter(
            (node) =>
              node.stage === openingStage && node.kind === openingDraftKind && node.supersededByNodeId === null,
          )
          .sort((a, b) => a.version - b.version)
          .at(-1) ?? null)
      : null;
  const openingDraftNodeIdKey = openingDraftNode?.id ?? null;
  useEffect(() => {
    setOpeningDraftNodeId(openingDraftNodeIdKey);
  }, [openingDraftNodeIdKey]);
  const openingDraft =
    openingDraftNode && openingDraftContent !== null
      ? { title: openingDraftNode.title, version: openingDraftNode.version, content: openingDraftContent }
      : null;
  const openingWho = openingStage >= 1 && openingStage <= 9 ? agentFor(openingStage as Stage).title.toLowerCase() : "specialist";

  // Neutral until the workflow view says which stage this really is — never
  // the artifact-derived fallback, which for a mid-way project is stage 1
  // and would otherwise flash before the real stage takes over (CL-8721).
  if (!workflowResolved && !openingFailed) {
    return (
      <OpeningScreen
        resuming={resuming}
        who={openingWho}
        opening={openingStatement}
        draft={openingDraft}
      />
    );
  }

  // The strip and conversation are the same on every stage; only the right
  // pane's surface changes. Selecting a tab for another stage reads that
  // artifact — the stage's own surface only owns its own tab.
  const stripEl = artifacts.selected ? (
    <>
      <ArtifactStrip
        tabs={artifacts.tabs}
        selectedKey={artifacts.selected.key}
        onSelect={artifacts.select}
      />
      {artifacts.activeNode ? (
        <VersionSelect
          tab={artifacts.selected}
          activeId={artifacts.activeNode.id}
          onSelect={artifacts.selectVersion}
        />
      ) : null}
    </>
  ) : null;

  // A past stage's document, opened from the stepper: read as what it is
  // (a design is a page in a sandbox, a file is a file), headed by which
  // stage it belongs to, with the two things a person can do from here --
  // go back to this stage's work, or send the project back to change it.
  // A stage whose pane is a panel of its own (the design, the packages, the
  // build, the delivery) shows only its own lineage's newest version there,
  // so a tab or a version chip naming anything else read as doing nothing:
  // the reader shows it instead, as it does another stage's.
  const panelCannotShow =
    artifacts.selected !== null &&
    artifacts.activeNode !== null &&
    artifacts.selected.stage === stage &&
    !DOCUMENT_STAGES.has(stage) &&
    (artifacts.selected.kind !== STAGE_DRAFT_KIND[stage] || artifacts.activeNode.id !== artifacts.selected.versions.at(-1)?.id);
  const reader =
    artifacts.selected !== null && (artifacts.selected.stage !== stage || panelCannotShow) && artifacts.activeNode ? (
      <div className="stage-inner">
        <div className="doc reader-doc">
          <div className="docmeta">
            <span>
              <b>{stageName(artifacts.activeNode.stage)}</b> · {documentName(artifacts.activeNode.kind)}
              {artifacts.activeNode.supersededByNodeId ? " · superseded" : " · viewing"}
            </span>
            <div className="document-tools">
              {artifacts.activeNode.mediaType === "text/html" || artifacts.activeNode.kind === "design_artifact" ? (
                <FrameSelect value={frameMode} onChange={setFrameMode} />
              ) : null}
              <CopyButton text={isDataUrl(artifacts.activeContent) ? null : artifacts.activeContent} />
              {readerDeckNode ? (
                recordedDeck.exportMenu
              ) : artifacts.activeContent && !isDataUrl(artifacts.activeContent) ? (
                // The same way out every stage document has (#242): Markdown, or the print layer's PDF.
                <DocumentExportMenu node={artifacts.activeNode} tenantId={tenantId} content={artifacts.activeContent} />
              ) : null}
              <Button
                variant="ghost"
                onClick={() => {
                  artifacts.select(null);
                  artifacts.selectVersion(null);
                }}
              >
                <ArrowLeft aria-hidden="true" />
                Back to {stageName(stage)}
              </Button>
              {artifacts.activeNode.stage < stage ? (
                <Button variant="ghost" disabled={decisions.sendingBack} onClick={() => setReaderSendBack((open) => !open)}>
                  <Undo2 aria-hidden="true" />
                  Change it: send back to {stageName(artifacts.activeNode.stage)}…
                </Button>
              ) : null}
            </div>
          </div>
          {readerSendBack && artifacts.activeNode.stage < stage ? (
            <SendBackConfirm
              target={artifacts.activeNode.stage}
              busy={decisions.sendingBack}
              onCancel={() => setReaderSendBack(false)}
              onConfirm={(typed) => {
                const target = artifacts.activeNode!.stage;
                setReaderSendBack(false);
                void sendBack(target, composeSendBackReason(loadQuotedDraft(tenantId, stage), typed));
              }}
            />
          ) : null}
          {recordedDeck.notice ? <p className="inline-note">{recordedDeck.notice}</p> : null}
          {readerDeckNode ? (
            recordedDeck.deck ? (
              <SlidePreview key={readerDeckNode.id} deck={recordedDeck.deck} note={recordedDeck.note} />
            ) : (
              <p className="inline-note">{recordedDeck.note ?? "Drawing the slides…"}</p>
            )
          ) : !artifacts.activeContent ? (
            <p className="inline-note">Loading…</p>
          ) : isDataUrl(artifacts.activeContent) ? (
            <BinaryFile node={artifacts.activeNode} tenantId={tenantId} content={artifacts.activeContent} />
          ) : artifacts.activeNode.mediaType === "text/html" || artifacts.activeNode.kind === "design_artifact" ? (
            // Each phone screen in an iPhone, the rest in the page frame
            // (#101); one frame per document, mounted only once its
            // document is here.
            <DesignFrames
              framed={framedDesign(artifacts.activeContent, frameMode, artifacts.activeNode.title)}
              frameKey={artifacts.activeNode.id}
              title={`${stageName(artifacts.activeNode.stage)} v${artifacts.activeNode.position}`}
              paneClassName="artifact-page"
            />
          ) : (
            <Markdown source={artifacts.activeContent} {...(artifacts.activeNode.kind === PRD_FOR_PEOPLE_KIND && peoplePictures ? { images: peoplePictures } : {})} />
          )}
        </div>
      </div>
    ) : null;

  // A requirements document or a review open beside the plan can be handed
  // to the architect as a message (#345).
  const sendToArchitect = () => {
    const node = artifacts.activeNode;
    const content = artifacts.activeContent;
    if (!node || !content) return null;
    const doc =
      node.kind === "product_requirements"
        ? requirementsDocument(content)
        : node.kind === "engineering_review" && node.variant
          ? reviewDocument(node.variant, content)
          : null;
    if (!doc) return null;
    return (
      <Button variant="ghost" disabled={sending} onClick={() => void send(documentAsMessage(doc))}>
        <Send aria-hidden="true" />
        Send to the architect
      </Button>
    );
  };

  // The stage's document with its gate. Stage 6's panel renders it, so the
  // plan's toolbar can hold the panel's review menu.
  const activeNode = artifacts.activeNode;
  const selectedTab = artifacts.selected;
  const stageDocument =
    agentAddress && DOCUMENT_STAGES.has(stage) && draftMessage && viewedStage === null && activeNode && selectedTab
      ? (reviewMenu: ReactNode) => (
          <StageDocument
              node={activeNode}
              versions={selectedTab.versions}
              content={artifacts.activeContent}
              tenantId={tenantId}
              turns={turns}
              openQuestion={
                guidance.question
                  ? { text: guidance.question.text, ordinal: progress?.ordinal ?? null, total: progress?.total ?? null }
                  : null
              }
              evaluation={
                stage === 1 && evaluator.status === "verdict"
                  ? { ready: evaluator.verdict.ready, notes: [...evaluator.verdict.notes] }
                  : null
              }
              advisory={stage === 1 ? <EvaluatorStance evaluator={evaluator} /> : null}
              {...(draftRefs ? { draftRefs } : {})}
              onSelectVersion={artifacts.openVersion}
              onRevise={(message, quotes) => {
                artifacts.selectVersion(null);
                const quoted = quotes.map((entry) => `> ${entry.quote}`).join("\n");
                void send(quoted ? `${quoted}\n\n${message}` : message);
              }}
              onAddMaterial={addMaterial}
              attachNote={attachNote}
              onSubmit={() => void approve()}
              soloApproval={detail.soloApproval}
              canSubmit={approveAllowed && artifacts.isStageDraft && !superseded}
              busy={sending ? "draft" : approving || workflow.refreshingAfterAction ? "submit" : null}
              draftOpen={draftOpen}
              newer={artifacts.newerVersion}
              live={null}
              seed={stopSeed}
              withdrawnIds={withdrawnIds}
              pending={busy}
              onStop={() => void stopTurn()}
              onSendHold={openSendBack}
              composerPopover={sendBackPopover}
              events={events}
              strip={stripEl}
              tools={stage !== 6 ? null : artifacts.isStageDraft ? reviewMenu : sendToArchitect()}
              promote={
                superseded
                  ? {
                      label: `${selectedTab.label} v${activeNode.position} · superseded by v${selectedTab.versions.length}`,
                      run: () => void promote(),
                      busy: promoting,
                    }
                  : null
              }
              // Cost approval's two leads, each in the pane it is about (#619):
              // the summary heads the Cost document it is read from, and only
              // that document; the target question sits with the chat's other
              // questions, above the box.
              documentLead={
                stage === 7 && artifacts.isStageDraft ? (
                  <EstimateView body={artifacts.activeContent} freeze={workflowView?.freeze ?? null} />
                ) : null
              }
              composerLead={stage === 7 ? <TargetPicker chosen={chosenTarget} onChange={setChosenTarget} /> : null}
            />
        )
      : null;

  const conversation = (
    <StageConversation
      stage={stage}
      messages={shownMessages}
      value={composer}
      onValueChange={setComposer}
      onSend={() => {
        const body = composer;
        setComposer("");
        void send(body);
      }}
      working={sending}
      disabled={!agentAddress}
      withdrawnIds={withdrawnIds}
      pending={busy}
      onStop={() => void stopTurn()}
      onSendHold={() => openSendBack(composer)}
      popover={sendBackPopover}
      events={events}
      who={stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title : "Specialist"}
      placeholder={`Message the ${stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title.toLowerCase() : "specialist"}…`}
      onAttach={(files) => void addMaterial([...files])}
      rows={
        <>
          {attachNote ? <p className="warning-note" role="alert">{attachNote}</p> : null}
          {/* Stage 4's gate sits above the box like every document stage's
              (#720), not at the end of the design pane's tools row. The
              workflow's verdict is its only gate. */}
          {stage === 4 && approveAllowed ? (
            <div className="stage-action composer-approve">
              <span className="composer-approve-lead">
                <span>{detail.soloApproval ? "Happy with it?" : "Nothing more to say?"}</span>
              </span>
              <span className="approve">
                <Button variant="ghost" loading={approving || workflow.refreshingAfterAction} onClick={() => void approve()}>
                  <Check aria-hidden="true" />
                  {detail.soloApproval ? "Approve and continue" : "Send for approval"}
                </Button>
              </span>
            </div>
          ) : null}
          {/* Stage 5's gate, the quorum tally included, sits here too (#725). */}
          {stage === 5 ? (
            <AudienceGate
              detail={detail}
              tenantId={tenantId}
              workflowView={workflowView}
              canApprove={approveAllowed}
              approving={approving || workflow.refreshingAfterAction}
              approveReason={workflowView?.allowed.approveReason ?? null}
              lastRefusal={workflowView?.lastRefusal ?? null}
              onApprove={() => void approve()}
              onChanged={() => void refreshWorkflow()}
            />
          ) : null}
        </>
      }
      {...(draftRefs ? { draftRefs } : {})}
      onOpenVersion={artifacts.openVersion}
    />
  );

  return (
    <div className="stage-view">

      {openingFailed ? (
        <Banner
          tone="error"
          title={
            workflow.startError
              ? `The project workflow could not be started: ${workflow.startError}`
              : "The project workflow could not be read."
          }
          action={{ label: "Try again", onClick: workflow.retryOpening }}
        />
      ) : null}

      {workflow.replayNotice ? (
        <Banner tone="warning" title={workflow.replayNotice.title}>
          {workflow.replayNotice.detail}
        </Banner>
      ) : null}

      {error ? (
        <Banner
          tone="error"
          title={error}
          {...(remediation
            ? {
                action: {
                  label: remediation.label,
                  onClick: () => {
                    if (remediation.kind === "retry") {
                      setError(null);
                      setRemediation(undefined);
                      return;
                    }
                    if (remediation.kind === "send_back") {
                      // The picker, seeded with the reason: the person
                      // still names the stage, so the send-back is theirs.
                      setError(null);
                      setRemediation(undefined);
                      openSendBack(remediation.reason ?? "");
                      return;
                    }
                    if (remediation.kind === "ask_specialist") {
                      // The ready-made ask goes to the specialist as the
                      // person's own message (#325); `send` clears the banner.
                      void send(remediation.message ?? "");
                      return;
                    }
                    onOpenSettings();
                  },
                },
              }
            : {})}
        />
      ) : null}

      {!agent.error ? (
        <div className="stage-model-row" data-inference-pending={busy ? "" : undefined}>
          {/* The flame burns while a specialist turn is in flight and sits
              still otherwise (#87); the text keeps the state readable. */}
          <span className="inference-flame" role="img" aria-label={busy ? "Inference running" : "Inference idle"}>
            <Flame aria-hidden="true" />
          </span>
          <label className="stage-model-label" htmlFor="stage-inference">
            Inference
          </label>
          {/* The select is the one place the running model is named: it
              shows the running row, or, when no Settings row matches it,
              the running model itself as the unchosen first option. */}
          <select
            id="stage-inference"
            aria-label="Switch this stage's inference"
            title="The provider and model rows from Settings, in their order. Choosing one makes it the default there and switches this stage to it."
            disabled={!agentAddress || modelSwitch.switching || inferenceProviders === null}
            value={runningInference?.providerRowId ?? ""}
            onChange={(event) => {
              const option = inferenceChoices.find((entry) => entry.providerRowId === event.target.value);
              if (option) void pickInference(option);
            }}
          >
            <option value="" disabled>
              {modelSwitch.switching
                ? "Switching…"
                : !agentAddress
                  ? "Setting up…"
                  : activeModel
                    ? `${activeModel.providerLabel} · ${activeModel.canonicalName}`
                    : "Loading…"}
            </option>
            {inferenceChoices.map((option) => (
              <option key={option.providerRowId} value={option.providerRowId}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {!agentAddress && agent.error ? (
        <Banner
          tone="error"
          title={`The ${stageName(stage).toLowerCase()} specialist could not be started`}
          action={{ label: "Try again", onClick: agent.retry }}
        >
          {agent.error}
        </Banner>
      ) : null}

      {!agentAddress && !agent.error ? (
        <OpeningScreen
          resuming={resuming}
          who={openingWho}
          opening={openingStatement}
          draft={openingDraft}
        />
      ) : null}

      {/* The owner's ask: a calm inline prompt, never a modal wall, and never
          a redeploy without the person choosing — "Keep" just dismisses
          (remembered per project+stage until the default moves again),
          "Switch" runs the same switch path the manual select above uses. */}
      {modelNudgeVisible && workspaceDefaultModel && defaultOffering ? (
        <div className="model-nudge" role="status">
          <span className="inline-note">
            Your default model is now {workspaceDefaultModel.providerLabel} · {workspaceDefaultModel.canonicalName}.
            Switch this stage to it?
          </span>
          <div className="model-nudge-actions">
            <Button
              onClick={() => {
                dismissModelNudge();
                void modelSwitch.switchTo(defaultOffering.offeringId);
              }}
            >
              Switch
            </Button>
            <Button variant="ghost" onClick={dismissModelNudge}>
              Keep {activeModel?.canonicalName}
            </Button>
          </div>
        </div>
      ) : null}

      {modelSwitch.error ? <Banner tone="error" title="The inference could not be switched">{modelSwitch.error}</Banner> : null}
      {modelHandoff.error ? (
        <Banner tone="error" title="The new specialist could not be told about the prior conversation">
          {modelHandoff.error}
        </Banner>
      ) : null}

      {/* Bottom right, over the canvas: always to hand, never a band of the
          window given to one sentence. */}
      <GuideDock
        stage={stage}
        step={guideStep(guideContext)}
        at="stage"
        onGo={(where) => {
          if (where === "settings") onOpenSettings();
          else if (where === "decisions") onOpenDecisions?.();
        }}
        onExplain={() => void guide.explain()}
        guidance={guide.guidance}
        explaining={guide.explaining}
        note={guide.note}
        now={agentAddress ? { title: guidance.title, detail: guidance.detail } : null}
      />

      {agentAddress && openingDispatch.error ? (
        <Banner
          tone="error"
          title="The opening message could not be sent"
          action={{ label: "Try again", onClick: openingDispatch.retry }}
        >
          {openingDispatch.error}
        </Banner>
      ) : null}

      {agentAddress && stage === 4 ? (
        <StagePanes strip={stripEl} conversation={conversation} busy={busy}>
          {reader ?? (
            <DesignPanel
              detail={detail}
              tenantId={tenantId}
              onChanged={() => void refreshWorkflow()}
              onRevise={(prompt) => send(prompt)}
              latestReply={latestDesign}
            />
          )}
        </StagePanes>
      ) : null}

      {agentAddress && stage === 5 ? (
        <StagePanes strip={stripEl} conversation={conversation} busy={busy}>
          {reader ?? (
            <div className="stage-inner">
              <AudiencePackages
                detail={detail}
                tenantId={tenantId}
                messages={foldedMessages}
                onChanged={() => {
                  void refreshWorkflow();
                  void loadThread();
                }}
                workflowView={workflowView}
                onStakeholdersSaved={() => void openReviewNow()}
              />
            </div>
          )}
        </StagePanes>
      ) : null}

      {agentAddress && stage === 8 ? (
        <BuildPanel
          detail={detail}
          tenantId={tenantId}
          freeze={workflowView?.freeze ?? null}
          attempts={builds.attempts}
          refreshAttempts={builds.refresh}
          onChanged={() => void refreshWorkflow()}
          onOpenSettings={onOpenSettings}
          onApprove={approve}
          approving={approving || workflow.refreshingAfterAction}
          canApprove={approveAllowed}
          strip={stripEl}
          reader={reader}
          stageEvents={events}
          onSendHold={openSendBack}
          popover={sendBackPopover}
          onAttach={(files) => void addMaterial([...files])}
          attachNote={attachNote}
        />
      ) : null}

      {agentAddress && stage === 8 ? (
        // The senior-engineer panel on the build's evidence (#341): asked
        // against the frozen stack and the build supervisor's latest status,
        // each reply recorded as the reviewer's build_review document.
        <PanelReviewsCompanion
          projectId={detail.project.id}
          tenantId={tenantId}
          stage={8}
          reviewInput={
            latestSpecialistMessage && decisions.stage8Evidence?.ready
              ? [workflowView?.freeze ? renderStackBlock(workflowView.freeze) : null, "## Build evidence, as the build supervisor reported it", latestSpecialistMessage.body]
                  .filter((part): part is string => part !== null)
                  .join("\n\n")
              : null
          }
          reviewNodes={panelReviewNodesOf(detail.nodes, 8)}
          onDocumentsChanged={onChanged}
          onDocuments={setStageDocuments}
        />
      ) : null}

      {agentAddress && stage === 6 ? (
        <Stage6Panel
          tenantId={tenantId}
          projectId={detail.project.id}
          requirementsInput={openingDispatch.stage6Material}
          reviewInput={draftMessage?.body ?? null}
          requirementsBlock={workflowView ? renderRequirementsBlock(workflowView.requirements) : null}
          requirementsMinted={!!workflowView && workflowView.requirements.length > 0}
          requirementsNode={
            detail.nodes
              .filter((node) => node.kind === "product_requirements" && node.supersededByNodeId === null)
              .sort((a, b) => b.version - a.version)[0] ?? null
          }
          people={prdForPeople.people}
          sendPeople={prdForPeople.send}
          designHtml={prdForPeople.designHtml}
          reviewNodes={reviewNodesOf(detail.nodes)}
          onDocumentsChanged={onChanged}
          onDocuments={setStageDocuments}
          requirementsAsk={requirementsAsk}
          onRequirementsDrafted={mintRequirements}
          strip={stripEl}
          conversation={conversation}
          reader={reader}
          pane={!(draftMessage && artifacts.activeNode && artifacts.selected)}
          planDocument={stageDocument}
        />
      ) : null}

      {agentAddress && DOCUMENT_STAGES.has(stage) && stage !== 6 && !draftMessage ? (
        // No drafted artifact yet: a single centered column, chat only, no
        // right pane — the split only earns its keep once there is
        // something to split against.
        <StagePanes
          strip={stripEl}
          conversation={conversation}
          solo
          className="chat-first"
          busy={busy}
        >
          {reader}
        </StagePanes>
      ) : null}

      {/* A past stage opened from the stepper while this stage has a draft:
          the reader, not this stage's document and its approve gate. */}
      {agentAddress && DOCUMENT_STAGES.has(stage) && draftMessage && viewedStage !== null ? (
        <StagePanes strip={stripEl} conversation={conversation} busy={busy}>
          {reader}
        </StagePanes>
      ) : null}

      {stage === 6 ? null : stageDocument?.(null)}

      {agentAddress && stage === 9 ? (
        <StagePanes strip={stripEl} conversation={conversation} busy={busy}>
          {reader ?? (
            <div className="stage-inner">
              <DeliveryPanel
                detail={detail}
                tenantId={tenantId}
                archiveRef={
                  workflowView?.reviews[8]?.status === "approved"
                    ? { artifactId: workflowView.reviews[8].artifactId, version: workflowView.reviews[8].version }
                    : null
                }
                latestReply={latestSpecialistMessage}
                onAccept={acceptDelivery}
                onRejectSendBack={() => void sendBack(8)}
              />
            </div>
          )}
        </StagePanes>
      ) : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
function DesignPanel({
  detail,
  tenantId,
  onChanged,
  onRevise,
  latestReply,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** Sends free-form feedback text to the stage-4 specialist's mail thread. */
  onRevise: (prompt: string) => Promise<unknown>;
  /** The specialist's latest unpersisted reply — the mockup, before approval. */
  latestReply: ChatMessage | null;
}) {
  // The design history is just this project's `design_artifact` nodes —
  // already on `detail`, so no route of its own is needed to read it. Under
  // the mail-chat contract nothing writes one of these until approval, so
  // the specialist's latest reply stands in as a not-yet-persisted design
  // while none exists yet.
  const persisted = useMemo(() => designHistory(detail.nodes), [detail.nodes]);
  const draftNode: ArtifactNode | null = latestReply
    ? {
        id: `reply:${latestReply.id}`,
        kind: "design_artifact",
        variant: null,
        stage: 4,
        title: stageName(4),
        version: (persisted.at(-1)?.version ?? 0) + 1,
        position: (persisted.at(-1)?.position ?? 0) + 1,
        artifactId: `reply:${latestReply.id}`,
        contentHash: "",
        sizeBytes: latestReply.body.length,
        mediaType: "text/html",
        createdAt: latestReply.at,
        supersededByNodeId: null,
        provenance: { producer: "specialist" },
      }
    : null;
  const designs = persisted.length > 0 ? persisted : draftNode ? [draftNode] : [];
  const [contentByNode, setContentByNode] = useState(new Map<string, string>());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const contents = await Promise.all(
      persisted.map(async (design) => {
        // An unreadable version is not an empty one. Saying so on the version
        // itself keeps the rest of the history usable.
        const artifact = await api.artifactContent(tenantId, design.id).catch(() => null);
        return [design.id, artifact?.content ?? UNREADABLE] as const;
      }),
    );
    setContentByNode(new Map(draftNode ? [...contents, [draftNode.id, latestReply?.body ?? ""] as const] : contents));
  }, [persisted, tenantId, draftNode?.id, latestReply?.body]);

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setLoadError(`The design history could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }, [load]);

  return (
    // The stage fills the window and clips, so this is the region that
    // scrolls: a mockup, its comments and the feedback form together run
    // well past one screen.
    <div className="design-review">
      {loadError ? (
        <Banner tone="error" title="The design history could not be read">
          {loadError}
        </Banner>
      ) : null}
      <DesignFeedbackView
        designs={designs}
        feedbackByNode={new Map<string, FoldedFeedback>()}
        contentByNode={contentByNode}
        tenantId={tenantId}
        revise={(_feedback, prompt) => onRevise(prompt)}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

/**
 * The senior engineer panel's four independent reviews.
 *
 * Shown side by side and never merged. Section 8 makes the four principals
 * independent, and a UI that concatenates them into one scrolling document
 * undoes that at the last step — the reader has to be able to see that
 * security and platform reached their verdicts separately.
 */
/**
 * Stage 6's requirements, beside the plan: what stages 1 to 4 agreed,
 * gathered into the document the plan is written against. Folded to one line
 * by default, since the plan is what the person is here to read.
 */
export function ProductRequirements({
  node,
  tenantId,
  canRewrite,
  busy,
  onRewrite,
}: {
  node: ArtifactNode;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  canRewrite: boolean;
  busy: boolean;
  onRewrite: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    void api
      .artifactContent(tenantId, node.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, tenantId]);
  return (
    <Screen
      title="Product requirements"
      description="What the stages through GUI design agreed, gathered into the one document the plan is written against. The plan cites its ids."
      status={<StateLabel tone="info">Version {node.position}</StateLabel>}
      tight
    >
      <details className="document-fold">
        <summary className="document-fold-summary">
          <span className="document-fold-title">Requirements</span>
          <span className="document-fold-digest">{versionDigest(node)}</span>
        </summary>
        <div className="document-body document-fold-body">
          {content === null ? <p className="inline-note">Loading…</p> : <Markdown source={content} />}
        </div>
      </details>
      {canRewrite ? (
        <div className="button-row">
          <Button loading={busy} onClick={onRewrite}>
            Write the requirements again
          </Button>
        </div>
      ) : null}
    </Screen>
  );
}

export function PanelReviews({ reviews, tenantId }: { reviews: ArtifactNode[]; tenantId: string }) {
  const live = reviews.filter((node) => node.supersededByNodeId === null);
  const [openId, setOpenId] = useState<string | null>(live[0]?.id ?? null);
  const [contents, setContents] = useState(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      live.map(async (node) => {
        const result = await api.artifactContent(tenantId, node.id).catch(() => null);
        return [node.id, result?.content ?? UNREADABLE] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setContents(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [live.map((node) => node.id).join(","), tenantId]);

  const open = live.find((node) => node.id === openId) ?? live[0] ?? null;
  const body = open ? (contents.get(open.id) ?? "") : "";
  const verdictOf = (text: string) => {
    const match = /##\s*Verdict\s*\n+([^\n#]+)/i.exec(text);
    return match?.[1]?.trim() ?? null;
  };
  // Folded, the line carries every principal's verdict, so the four can be
  // compared without opening any of them.
  const verdicts = live
    .map((node) => `${node.variant ?? node.title}: ${verdictOf(contents.get(node.id) ?? "") ?? "…"}`)
    .join(" · ");

  return (
    <Screen
      title="Independent engineering review"
      description="Four principals reviewed this plan separately. Their findings are not merged."
      tight
    >
      <details className="document-fold">
        <summary className="document-fold-summary">
          <span className="document-fold-title">Reviews</span>
          <span className="document-fold-digest">{verdicts}</span>
        </summary>
        <div className="document-fold-body">
          <Tabs
            label="Panel principals"
            active={open?.id ?? ""}
            onChange={setOpenId}
            tabs={live.map((node) => ({
              id: node.id,
              label: node.variant ?? node.title,
            }))}
          >
            {/* The review reads inside the panel the tab controls, so switching
                principals announces the finding rather than an empty region. */}
            {() => (
              <>
                <p className="inline-note">
                  {open ? (verdictOf(contents.get(open.id) ?? "") ?? "No verdict stated.") : null}
                </p>
                <div className="document-body">
                  {body ? <Markdown source={body} /> : <p className="inline-note">Loading…</p>}
                </div>
              </>
            )}
          </Tabs>
        </div>
      </details>
    </Screen>
  );
}
