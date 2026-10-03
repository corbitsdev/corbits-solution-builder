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
import { isStageOpening } from "./composed-mail.ts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "../../queries/keys.ts";
import {
  api,
  ApiFailure,
  createHubTransport,
  type ArtifactNode,
  type ProjectDetail,
  type StageTurn,
} from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { Markdown } from "../../markdown.jsx";
import { BinaryFile, isDataUrl } from "../../binary-file.tsx";
import { AudiencePackages } from "../audiences.jsx";
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
import { interviewProgress, latestDesignReply, workspaceGuidance } from "./guidance.js";
import { repairedChoiceDraft } from "./choice-repair.ts";
import { artifactTag, taggedSubject } from "./composed-mail.ts";
import { attachableDocuments, attachedIn, attachedSubjectTags, type AttachedDocument } from "./attach-documents.tsx";
import { repairedStackDraft, stackCarriedFromEarlierVersion } from "./stack-repair.ts";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { stageUsesArtifactTools } from "@solutions-builder/app/specialist-source";
import { documentVersions, draftReferences } from "./draft-references.ts";
import { designHistory } from "./design-history.ts";
import { ArrowLeft, Flame, Undo2 } from "lucide-react";
import { useWorkflowView } from "./use-workflow-view.ts";
import { useStageAgent } from "./use-stage-agent.ts";
import { useStageThread } from "./use-stage-thread.ts";
import { useWithdrawnTurns } from "./use-withdrawn-turns.ts";
import { useSpecialistRunState } from "./use-specialist-run-state.ts";
import { specialistBusy } from "../../specialist-run-state.ts";
import { useOpeningDispatch } from "./use-opening-dispatch.ts";
import { useEvaluatorRevision, useProductGuide, useStageEvaluator } from "./use-advisory.ts";
import { markerAlreadySent } from "../../decision-notify.ts";
import { guideStep } from "./product-guide.ts";
import { useProjectArtifacts } from "./use-project-artifacts.ts";
import { clearQuotedDraft, loadQuotedDraft } from "./quote-store.js";
import { ApproveControl } from "./approve-control.tsx";
import { stage6StackRemediation } from "../../stage-evidence.ts";
import { useStageDecisions } from "./use-stage-decisions.ts";
import { composeSendBackReason } from "./send-back-reason.ts";
import { useRecordedDeck } from "./deck-reader.jsx";
import { DocumentExportMenu } from "../../document-export.jsx";
import { SlidePreview } from "../../slide-preview.jsx";
import { ArtifactStrip, VersionStrip } from "./artifact-strip.tsx";
import { stageEvents, switchEvents, type StageEvent } from "./stage-events.ts";
import { useModelSwitch, useModelHandoff } from "./use-model-handoff.ts";
import { currentInference, inferenceOptions, inferenceRemoved } from "./inference-options.ts";
import { dismissPrimary, useDismissedPrimary, useModelMismatch, writeModelMismatch } from "./model-nudge-store.ts";
import { useMountEffect } from "../../use-mount-effect.ts";
import { Stage6Panel } from "./stage6.tsx";
import { PanelReviewsCompanion, reviewNodesOf } from "./panel-reviews.tsx";
import { renderStackBlock } from "./frozen-stack-text.ts";
import { askKind, requirementsRequest, routedLine } from "./message-intent.ts";
import { TERMINAL_RUN_NOTICE, isTerminalRunRefusal } from "./terminal-run.ts";
import { renderRequirementsBlock } from "@solutions-builder/app/requirements";
import { agentFor, evaluatorFor } from "@solutions-builder/app/kit";
import type { Stage } from "@solutions-builder/app/ledger";
import { STAGE_DRAFT_KIND, type StageWorkArtifact } from "../../client.js";
import {
  EvaluatorStance,
  OpeningScreen,
  SendBackConfirm,
  SendBackPopover,
  StagePanes,
} from "./workspace-chrome.tsx";
import type { FoldedFeedback } from "@solutions-builder/app/design-prompt";

/** Stages whose draft is prose read in the two-pane document, rather than
 * one of the specialised panels (design, audiences, build) or the final
 * decisions stage. */
const DOCUMENT_STAGES = new Set([1, 2, 3, 6, 7]);

/** A drafting stage's artifact, as last read: there is none yet, it was
 *  read, or it exists and could not be read, which is shown, not hidden. */
type WorkArtifact =
  | { readonly state: "none" }
  | { readonly state: "ready"; readonly artifact: StageWorkArtifact }
  | { readonly state: "unreadable"; readonly message: string };

const SURFACE_NOTE = "Choose what the finished build is. A command or a service has no screens, so GUI design is skipped for it.";

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
  const opening = useQuery({
    queryKey: keys.projectOpening.of(detail.project.id),
    queryFn: async () => (await api.projectOpening(detail.project.id))?.body ?? null,
    staleTime: Infinity,
  });
  const openingStatement = opening.isPending ? undefined : (opening.data ?? null);

  // The opening screen's own current-stage draft content — read the same
  // way `ProductRequirements` reads a single node's content below, off the
  // artifact fold already on `detail.nodes` rather than the mail thread, so
  // it renders before the stage specialist (and its mailbox) exist at all.
  const [openingDraftNodeId, setOpeningDraftNodeId] = useState<string | null>(null);
  // An artifact id names a fixed version, so its content is never stale.
  const openingDraftRead = useQuery({
    queryKey: keys.artifact.of(tenantId, openingDraftNodeId ?? ""),
    queryFn: async () => (await api.artifactContent(tenantId, openingDraftNodeId!)).content,
    enabled: openingDraftNodeId !== null,
    staleTime: Infinity,
    retry: false,
  });
  const openingDraftContent = openingDraftNodeId === null ? null : openingDraftRead.isError ? UNREADABLE : (openingDraftRead.data ?? null);

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
  // A nudge is also a reply landing, by which time the specialist has
  // written the stage's artifact.
  const queryClient = useQueryClient();
  const nudgeWorkflow = useCallback(() => {
    void workflow.reload();
    void queryClient.invalidateQueries({ queryKey: keys.stageWork.all });
  }, [workflow.reload, queryClient]);
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
    (body) => {
      setComposer(body);
      setStopSeed({ text: body, at: Date.now() });
    },
    setError,
  );
  const foldedMessages = withdrawn.messages;
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
  useBusyWhile(busy, specialistActivity(stage, askKind(pending?.body ?? null, foldedMessages.some((message) => message.author === "agent"))));

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
  // A drafting stage with artifact tools keeps its document in an artifact
  // the specialist writes; the host reads the newest one of the stage's kind
  // rather than trusting what the reply says it wrote. It is read again when
  // a reply lands, and polled while one is pending so the pane follows the
  // specialist's writes. A stage with no artifact yet, such as a project
  // drafted before the tools, keeps reading its draft from the mail.
  const usesArtifact = stageUsesArtifactTools(stage as Stage);
  const workKind = STAGE_DRAFT_KIND[stage] ?? null;
  const awaitingReply = foldedMessages.at(-1)?.author === "me";
  // Keyed on the thread's newest message as well, so a reply that just
  // landed is read again, and the previous read stands in until it is --
  // never another stage's or project's document.
  const workQuery = useQuery({
    queryKey: [...keys.stageWork.of(tenantId, workKind ?? ""), foldedMessages.at(-1)?.id ?? null],
    queryFn: usesArtifact && workKind !== null ? () => api.stageWorkArtifact(tenantId, workKind) : skipToken,
    refetchInterval: awaitingReply ? 5_000 : false,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId && previousQuery.queryKey[2] === (workKind ?? "") ? previous : undefined,
  });
  // Until the read is the current thread's, a reply that just landed may sit
  // beside the document as it was before that reply.
  const workCurrent = !workQuery.isPlaceholderData;
  const work = useMemo((): WorkArtifact | null => {
    if (workQuery.error) return { state: "unreadable", message: workQuery.error.message };
    if (workQuery.data === undefined) return null;
    return workQuery.data ? { state: "ready", artifact: workQuery.data } : { state: "none" };
  }, [workQuery.error, workQuery.data]);
  // The stage 3 choice (#430) and the stage 6 Stack block (#437) are
  // repaired in the document itself, as its next version, so the pane, the
  // review and the approval all name a version that holds the repair.
  // Never while a reply is pending: the specialist is still writing.
  const settledArtifact = work?.state === "ready" && workCurrent && !awaitingReply ? work.artifact : null;
  // Each version is checked for a repair once, so a repair is written once.
  const repairChecked = useRef(new Set<string>());
  // The version checked and left as it is: one a review may name.
  const [checkedVersion, setCheckedVersion] = useState<string | null>(null);
  const refetchWork = workQuery.refetch;
  useEffect(() => {
    if (!settledArtifact) return;
    const key = versionIdFor(settledArtifact.id, settledArtifact.version);
    if (repairChecked.current.has(key)) return;
    repairChecked.current.add(key);
    const repairOf = async (artifact: StageWorkArtifact): Promise<string | null> => {
      if (stage === 3 && latestSpecialistMessage) {
        const repaired = repairedChoiceDraft(3, foldedMessages, { ...latestSpecialistMessage, body: artifact.content });
        return repaired && repaired.body !== artifact.content ? repaired.body : null;
      }
      if (stage === 6) {
        return stackCarriedFromEarlierVersion(
          artifact.content,
          artifact.version,
          async (version) => (await api.artifactContent(tenantId, versionIdFor(artifact.id, version))).content,
        );
      }
      return null;
    };
    void (async () => {
      try {
        const repaired = await repairOf(settledArtifact);
        if (repaired !== null) {
          await api.restoreStageDocument(tenantId, settledArtifact.id, repaired, settledArtifact.version);
          await refetchWork();
          return;
        }
      } catch (cause) {
        setError(`The document's repair could not be saved: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
      }
      setCheckedVersion(key);
    })();
  }, [settledArtifact, stage, tenantId, foldedMessages, latestSpecialistMessage, refetchWork]);
  const workSettled = settledArtifact !== null && checkedVersion === versionIdFor(settledArtifact.id, settledArtifact.version);
  const workDraft = useMemo(() => {
    if (!usesArtifact || work === null || work.state === "none") return guidance.draft;
    if (work.state === "unreadable" || !latestSpecialistMessage) return null;
    return { ...latestSpecialistMessage, body: work.artifact.content };
  }, [usesArtifact, work, guidance.draft, latestSpecialistMessage]);
  const workUnreadable = work?.state === "unreadable" ? work.message : null;
  useEffect(() => {
    if (workUnreadable) setError(`${workUnreadable} Approval waits until it can be read.`);
  }, [workUnreadable]);
  // A draft that lives in the mail is repaired here, before the pane or the
  // gate reads it, and that repaired text is what approval records: a stage
  // 3 choice absorbed anywhere but under "## Chosen approach" is written in
  // (#430), and a stage 6 plan that dropped its Stack block gets the last
  // valid one carried in (#437). A document kept in an artifact was
  // repaired as its own next version above.
  const artifactBacked = usesArtifact && work !== null && work.state !== "none";
  const draftMessage = useMemo(
    () =>
      artifactBacked ? workDraft : repairedStackDraft(stage, foldedMessages, repairedChoiceDraft(stage, foldedMessages, workDraft)),
    [artifactBacked, stage, foldedMessages, workDraft],
  );

  // A stage's evaluator reads each new draft against the record the stage
  // opened on; the Product guide answers when asked, on any stage. Both are
  // advisory and never touch the gate.
  const stageRecord = foldedMessages.find(isStageOpening)?.body ?? null;
  const evaluator = useStageEvaluator(detail.project.id, tenantId, stage as Stage, draftMessage?.body ?? null, stageRecord);
  const evaluated = evaluatorFor(stage as Stage) !== null;
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
  // Stage 4's design is the designer's artifact; a design sent as a reply is
  // read only for a project drafted before the tools.
  const latestDesign = useMemo(
    () => (artifactBacked ? workDraft : latestDesignReply(foldedMessages)),
    [artifactBacked, workDraft, foldedMessages],
  );
  // While the specialist is still answering, the pane follows its artifact
  // writes live, but nothing is opened for review: an intermediate write is
  // not a version, and recording one numbered the lineage twice per reply.
  // Nor before the stage's artifact has been read and settled: until then a
  // review could only be opened on a mail draft, which would be persisted
  // as a copy of a document that lives in the artifact.
  const reviewMessage =
    !threadLoaded || (usesArtifact && (awaitingReply || work === null || (artifactBacked && !workSettled)))
      ? null
      : DOCUMENT_STAGES.has(stage)
        ? draftMessage
        : stage === 4
          ? latestDesign
          : latestSpecialistMessage;
  // A document kept in an artifact is reviewed as the exact version the
  // pane shows once the reply that left it has landed, and any repair is
  // written; nothing is copied.
  const documentArtifact = reviewMessage && work?.state === "ready" ? work.artifact : null;
  const documentRef = useMemo(
    () =>
      documentArtifact
        ? { artifactId: documentArtifact.id, version: documentArtifact.version, contentSha256: documentArtifact.contentSha256 }
        : null,
    [documentArtifact],
  );
  const progress = useMemo(() => interviewProgress(foldedMessages), [foldedMessages]);

  // Mail turns as StageDocument's turn shape: it wants who spoke and what
  // was said, nothing this contract tracks beyond that (no per-turn quotes
  // or result-node bookkeeping under mail-chat).
  const turns: StageTurn[] = useMemo(
    () =>
      // The stage opening is what the specialist is sent, not something the
      // person said; the document strip already shows the record it carried.
      foldedMessages.filter((message) => !isStageOpening(message)).map((message) => ({
        id: message.id,
        role: message.author === "me" ? "human" : "specialist",
        body: message.body,
        quotes: [],
        resultNodeId: null,
        questions: null,
        createdAt: message.at,
        ...(message.subject ? { subject: message.subject } : {}),
      })),
    [foldedMessages],
  );

  const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
  // A document kept in an artifact: every version of it, in version order.
  const versionNodes = useMemo(
    () =>
      work?.state === "ready" && draftKind && work.artifact.versions.length > 0
        ? documentVersions(work.artifact, stage, draftKind, stageName(stage))
        : null,
    [work, draftKind, stage],
  );
  const artifacts = useProjectArtifacts(tenantId, stage, detail.nodes, draftMessage, versionNodes);
  // Each draft reply's version (#158): the conversation shows the reply as a
  // line naming it, on every document stage and on a reload alike, since
  // both the mail and the lineage are records. A document kept in an
  // artifact has no record of which reply wrote which version, so its
  // replies name none rather than guess one from two clocks.
  const liveVersions = artifacts.tabs.find((tab) => tab.live)?.versions;
  const draftRefs = useMemo(
    () =>
      DOCUMENT_STAGES.has(stage) && draftKind && !versionNodes
        ? draftReferences(foldedMessages, liveVersions ?? [], documentName(draftKind).toLowerCase())
        : undefined,
    [stage, draftKind, versionNodes, foldedMessages, liveVersions],
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
  // The centered conversation gives way to the split once there is a
  // document to show beside it.
  const split = draftMessage !== null && (viewedStage !== null || (artifacts.activeNode !== null && artifacts.selected !== null));

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
      ...routedEvents,
    ],
    [stage, workflowView?.decisions, detail.nodes, withdrawn.marks, foldedMessages, routedEvents],
  );

  // CL-8899: the current stage's provider/model, reporting-only (read off
  // the live deployment's pinned source, `resolveActiveModel`) — refetched
  // whenever the live address moves, since that's exactly when a new pin
  // has landed, whether from an explicit switch or any other redeploy.
  const activeModel =
    useQuery({
      queryKey: [...keys.activeModel.of(detail.project.id, stage), agentAddress],
      queryFn: () => api.activeModel(detail.project.id, stage),
    }).data ?? null;

  // The Inference picker: Settings' provider-and-model rows, in Settings'
  // order (`inference-options.ts`). Fetched once the specialist exists.
  const inferenceProviders =
    useQuery({
      queryKey: keys.providers,
      queryFn: async () => (await api.providers()).providers,
      enabled: agentAddress !== null,
    }).data ?? null;
  const inferenceChoices = inferenceOptions(inferenceProviders ?? []);
  const runningInference = currentInference(activeModel, inferenceChoices);
  const runningRemoved = inferenceRemoved(activeModel, inferenceProviders);

  const modelSwitch = useModelSwitch({ projectId: detail.project.id, stage });

  // Opening a project whose current stage runs a model other than the
  // primary asks, switches or keeps, as the person chose in Settings
  // (`useModelMismatch`). `workspaceDefaultModel` is unscoped
  // (`api.activeModel()`, no projectId/stage), the same read Settings'
  // "Primary model" row uses, so this and the deploy path agree on what the
  // primary is. "Keep" records the primary's OWN name per project+stage
  // (`model-nudge-store.ts`), so a later primary change asks again.
  const workspaceDefaultModel = useQuery({ queryKey: keys.activeModel.of(), queryFn: () => api.activeModel() }).data ?? null;
  const nudgeDismissedFor = useDismissedPrimary(detail.project.id, stage);
  const mismatchChoice = useModelMismatch();
  const [dontAskAgain, setDontAskAgain] = useState(false);
  // The primary is Settings' top row: the first inference option.
  const defaultOffering = inferenceChoices[0] ?? undefined;
  const modelDiffers =
    !!agentAddress &&
    !!activeModel &&
    !!workspaceDefaultModel &&
    !!defaultOffering &&
    activeModel.canonicalName !== workspaceDefaultModel.canonicalName;
  const modelNudgeVisible = modelDiffers && mismatchChoice === "ask" && nudgeDismissedFor !== workspaceDefaultModel?.canonicalName;
  const dismissModelNudge = () => {
    if (workspaceDefaultModel) dismissPrimary(detail.project.id, stage, workspaceDefaultModel.canonicalName);
  };
  // "Always switch" applies once the stage is known to be idle, so a switch
  // never lands mid-reply, and tries each primary once: a failed switch is
  // reported, not retried.
  const autoSwitchTo =
    mismatchChoice === "switch" && modelDiffers && !busy && runState.state !== "unknown" && modelSwitch.target !== defaultOffering?.offeringId
      ? defaultOffering
      : undefined;
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
    // The exact version the pane shows, once the reply that left it has landed.
    documentRef,
    draftKind,
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
    stackProblem,
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
    designRef: designReview?.status === "approved" ? versionIdFor(designReview.artifactId, designReview.version) : null,
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
      skipped={workflowView?.skipped ?? []}
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
  // content forward as the new head, versions are append-only. A document
  // kept in an artifact gets it as that artifact's next version.
  const [promoting, setPromoting] = useState(false);
  const superseded =
    artifacts.isStageDraft && artifacts.selected !== null && artifacts.activeNode !== null &&
    artifacts.activeNode !== artifacts.selected.versions.at(-1);
  const promote = async () => {
    if (!artifacts.activeContent || !superseded) return;
    // A document kept in an artifact that cannot be read now is never restored as a copy.
    if (artifactBacked && work?.state !== "ready") return;
    setPromoting(true);
    setError(null);
    try {
      if (work?.state === "ready") {
        await api.restoreStageDocument(tenantId, work.artifact.id, artifacts.activeContent, work.artifact.version);
        void refetchWork();
      } else {
        const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
        await api.persistStageDraft(detail.project.id, stage, artifacts.activeContent, materials);
      }
      await refreshWorkflow();
      artifacts.select(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setPromoting(false);
    }
  };

  // The evaluator's notes on a draft go to the specialist as one revision
  // before the person reviews it, folded in the chat as an event line.
  const notesError = useEvaluatorRevision({
    stage,
    evaluator,
    draft: !usesArtifact || workCurrent ? (draftMessage?.body ?? null) : null,
    messages: foldedMessages,
    send: async (ask, subject) => {
      if (!agentAddress) throw new Error("The specialist is not reachable yet.");
      // Another tab may already have sent these notes.
      if (await markerAlreadySent(createHubTransport(), tenantId, subject)) return;
      // Their own mail, not the person's: the notes' tag leads the subject
      // and the stage document's artifact tag rides after it.
      await api.sendStageMail(tenantId, agentAddress, {
        body: ask,
        subject: work?.state === "ready" ? `${subject} ${artifactTag(work.artifact)}` : subject,
      });
      await loadThread();
    },
  });

  /** Whether the message went; a refused one keeps its attachments in the composer. */
  const send = async (body: string, attached: readonly AttachedDocument[] = []): Promise<boolean> => {
    if (!agentAddress || body.trim().length === 0) return false;
    // A requirements request is the requirements author's (#407): it
    // goes to the companion's author with any named review attached, and
    // the chat says so where the message would have been. One with
    // documents attached was addressed to the architect, and goes there.
    if (stage === 6 && attached.length === 0 && requirementsRequest(body)) {
      const at = new Date().toISOString();
      setRequirementsAsk({ body, at: Date.now() });
      setRoutedEvents((prev) => [...prev, { id: `ev:routed:${String(prev.length)}`, at, text: `"${body.trim().slice(0, 80)}" — ${routedLine()}`, tone: "line" }]);
      return true;
    }
    setSending(true);
    setError(null);
    setRemediation(undefined);
    try {
      // The body is the person's words alone. The artifact holding the
      // stage's document travels in the subject, so a specialist that never
      // wrote it, such as one taking over after a model hand-off, revises it
      // instead of starting a second; so does each document attached.
      const tags = [...(work?.state === "ready" ? [artifactTag(work.artifact)] : []), ...(await attachedSubjectTags(tenantId, attached))];
      await api.sendStageMail(tenantId, agentAddress, { body, ...taggedSubject(tags, body) });
      await loadThread();
      return true;
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
        return false;
      }
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
      return false;
    } finally {
      setSending(false);
    }
  };

  // Only a stage whose specialist has run before is being reconnected to.
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
  const openingWho = agentFor(openingStage as Stage).title.toLowerCase();

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
        <VersionStrip
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
              <b>{stageName(artifacts.activeNode.stage)}</b> · {documentName(artifacts.activeNode.kind)} · v
              {artifacts.activeNode.position}
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
              {artifacts.activeNode.stage < stage && !workflowView?.skipped.includes(artifacts.activeNode.stage) ? (
                <Button variant="ghost" disabled={decisions.sendingBack} onClick={() => setReaderSendBack((open) => !open)}>
                  <Undo2 aria-hidden="true" />
                  Change it: send back to {stageName(artifacts.activeNode.stage)}…
                </Button>
              ) : null}
            </div>
          </div>
          {readerSendBack && artifacts.activeNode.stage < stage && !workflowView?.skipped.includes(artifacts.activeNode.stage) ? (
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
            <Markdown source={artifacts.activeContent} />
          )}
        </div>
      </div>
    ) : null;

  const attachDocuments = attachableDocuments(artifacts.tabs);
  const documentLabels = new Map(artifacts.tabs.flatMap((tab) => tab.versions.map((node) => [node.artifactId, tab.label] as const)));

  const stackAsk = stage6StackRemediation();
  const approveControl = (
    <ApproveControl
      label={detail.soloApproval ? "Approve" : "Send for approval"}
      evaluator={evaluated ? evaluator : null}
      notesError={notesError}
      waiting={
        stackProblem ? (
          <>
            {stackProblem}{" "}
            {/* One click asks the architect for the block in full (#325). */}
            <button type="button" className="btn link" onClick={() => void send(stackAsk.message ?? "")}>
              {stackAsk.label}
            </button>
          </>
        ) : null
      }
      busy={approving || workflow.refreshingAfterAction}
      onApprove={() => {
        // Quoted passages are for the stage being approved; once it is,
        // nothing is left to restore.
        clearQuotedDraft(tenantId, stage);
        void approve();
      }}
    />
  );

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
              advisory={evaluated ? <EvaluatorStance evaluator={evaluator} notesError={notesError} /> : null}
              lead={
                stage === 3 ? (
                  <TargetPicker chosen={chosenTarget} onChange={setChosenTarget} note={SURFACE_NOTE} verification={false} />
                ) : stage === 7 ? (
                  <>
                    <TargetPicker chosen={chosenTarget} onChange={setChosenTarget} />
                    <EstimateView body={draftMessage.body} freeze={workflowView?.freeze ?? null} />
                  </>
                ) : null
              }
              {...(draftRefs ? { draftRefs } : {})}
              onSelectVersion={artifacts.openVersion}
              onRevise={(message, quotes, _revise, attached) => {
                artifacts.selectVersion(null);
                const quoted = quotes.map((entry) => `> ${entry.quote}`).join("\n");
                return send(quoted ? `${quoted}\n\n${message}` : message, attached);
              }}
              documents={attachDocuments}
              attachedByTurn={new Map(foldedMessages.map((message) => [message.id, message.author === "me" ? attachedIn(message.subject, documentLabels) : []]))}
              onAddMaterial={async (files) => {
                await api.attachMaterial(detail.project.id, files);
                void refreshWorkflow();
              }}
              approve={approveControl}
              canSubmit={approveAllowed && artifacts.isStageDraft && !superseded && (stage !== 3 || chosenTarget !== null)}
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
              tools={stage === 6 && artifacts.isStageDraft ? reviewMenu : null}
              promote={
                superseded
                  ? {
                      label: `${selectedTab.label} v${activeNode.position} · superseded by v${selectedTab.versions.length}`,
                      run: () => void promote(),
                      busy: promoting,
                    }
                  : null
              }
            />
        )
      : null;

  const conversationWith = (rows: ReactNode) => (
    <StageConversation
      messages={foldedMessages}
      value={composer}
      onValueChange={setComposer}
      onSend={(attached) => {
        const body = composer;
        setComposer("");
        return send(body, attached);
      }}
      onAnswer={(answer) => {
        setComposer("");
        void send(answer);
      }}
      working={sending}
      disabled={!agentAddress}
      withdrawnIds={withdrawnIds}
      pending={busy}
      onStop={() => void stopTurn()}
      onSendHold={() => openSendBack(composer)}
      popover={sendBackPopover}
      events={events}
      rows={rows}
      who={stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title : "Specialist"}
      placeholder={`Message the ${stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title.toLowerCase() : "specialist"}…`}
      onAttach={(files) => {
        void api.attachMaterial(detail.project.id, [...files]).then(() => void refreshWorkflow());
      }}
      documents={attachDocuments}
      documentLabels={documentLabels}
      {...(draftRefs ? { draftRefs } : {})}
      onOpenVersion={artifacts.openVersion}
    />
  );
  const conversation = conversationWith(null);
  // A stage whose pane holds what approving waits on draws its own row.
  const panesWith = (row: ReactNode, pane: ReactNode) => (
    <StagePanes strip={stripEl} conversation={conversationWith(row)} busy={busy}>
      {reader ?? <div className="stage-inner">{pane}</div>}
    </StagePanes>
  );

  return (
    <div className="stage-view">
      {/* Stage 9 says this in its own pane, where it does not push the panes down. */}
      {workflowView?.done && (stage !== 9 || !agentAddress) ? (
        <Banner tone="okay" title="This project is delivered — stage 9's approval was recorded and the workflow has finished." />
      ) : null}

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

      {work?.state === "unreadable" ? (
        <Banner tone="error" title="The stage document could not be read">
          {work.message} Approval waits until it can be read.
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
            title={
              busy
                ? "Waits for the reply in flight: a stage never switches mid-reply."
                : "The provider and model rows from Settings, in their order. Choosing one switches this stage to it; the primary in Settings is unchanged."
            }
            disabled={!agentAddress || busy || modelSwitch.switching || inferenceProviders === null}
            value={runningInference?.providerRowId ?? ""}
            onChange={(event) => {
              const option = inferenceChoices.find((entry) => entry.providerRowId === event.target.value);
              if (option) void modelSwitch.switchTo(option.offeringId);
            }}
          >
            <option value="" disabled>
              {modelSwitch.switching
                ? "Switching…"
                : !agentAddress
                  ? "Setting up…"
                  : activeModel
                    ? `${activeModel.providerLabel} · ${activeModel.canonicalName}${runningRemoved ? " · provider removed, choose another" : ""}`
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


      {/* A calm inline prompt, never a modal wall, and never a redeploy the
          person did not choose. "Don't ask again" turns either answer into
          the Settings preference. */}
      {modelNudgeVisible && workspaceDefaultModel && activeModel ? (
        <div className="model-nudge" role="status">
          <p className="model-nudge-text">
            This project uses {activeModel.providerLabel} · {activeModel.canonicalName}. Your primary is now{" "}
            {workspaceDefaultModel.providerLabel} · {workspaceDefaultModel.canonicalName}.
            {busy ? " Switching waits for the reply in flight." : null}
          </p>
          <div className="model-nudge-actions">
            <label className="model-nudge-remember" title="Change this any time in Settings → Inference">
              <input type="checkbox" checked={dontAskAgain} onChange={(event) => setDontAskAgain(event.target.checked)} />
              Don't ask again
            </label>
            <Button
              variant="ghost"
              onClick={() => {
                if (dontAskAgain) writeModelMismatch("keep");
                dismissModelNudge();
              }}
            >
              {dontAskAgain ? "Always keep" : `Keep ${activeModel.canonicalName}`}
            </Button>
            <Button
              disabled={busy || modelSwitch.switching}
              onClick={() => {
                // "Always switch" is carried out by `autoSwitchTo` below.
                if (dontAskAgain) writeModelMismatch("switch");
                else if (defaultOffering) {
                  dismissModelNudge();
                  void modelSwitch.switchTo(defaultOffering.offeringId);
                }
              }}
            >
              {dontAskAgain ? "Always switch" : `Switch to ${workspaceDefaultModel.canonicalName}`}
            </Button>
          </div>
        </div>
      ) : null}
      {autoSwitchTo ? <OnMount action={() => void modelSwitch.switchTo(autoSwitchTo.offeringId)} /> : null}

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
        <StagePanes strip={stripEl} conversation={conversationWith(approveAllowed ? approveControl : null)} busy={busy}>
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
        <AudiencePackages
          detail={detail}
          tenantId={tenantId}
          onChanged={() => {
            void refreshWorkflow();
            void loadThread();
          }}
          onApprove={approve}
          approving={approving || workflow.refreshingAfterAction}
          canApprove={approveAllowed}
          approveReason={workflowView?.allowed.approveReason ?? null}
          lastRefusal={workflowView?.lastRefusal ?? null}
          workflowView={workflowView}
          onStakeholdersSaved={() => void openReviewNow()}
          panes={panesWith}
        />
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
          onAttach={(files) => {
            void api.attachMaterial(detail.project.id, [...files]).then(() => void refreshWorkflow());
          }}
          documents={attachDocuments}
          documentLabels={documentLabels}
        />
      ) : null}

      {agentAddress && stage === 8 && (decisions.stage8Evidence?.ready || reviewNodesOf(detail.nodes, 8).size > 0) ? (
        // The senior-engineer panel on the build's evidence (#341): asked
        // against the frozen stack and the build supervisor's latest status,
        // each reply recorded as the reviewer's build_review document. Absent
        // until there is a recorded build for it to read.
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
          reviewNodes={reviewNodesOf(detail.nodes, 8)}
          onDocumentsChanged={onChanged}
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
          reviewNodes={reviewNodesOf(detail.nodes, 6)}
          onDocumentsChanged={onChanged}
          requirementsAsk={requirementsAsk}
          onRequirementsDrafted={mintRequirements}
          strip={stripEl}
          conversation={conversation}
          reader={reader}
          pane={!(draftMessage && artifacts.activeNode && artifacts.selected)}
          planDocument={stageDocument}
        />
      ) : null}

      {agentAddress && DOCUMENT_STAGES.has(stage) && stage !== 6 && !split ? (
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
      {agentAddress && DOCUMENT_STAGES.has(stage) && split && draftMessage && viewedStage !== null ? (
        <StagePanes strip={stripEl} conversation={conversation} busy={busy}>
          {reader}
        </StagePanes>
      ) : null}

      {stage === 6 ? null : stageDocument?.(null)}

      {agentAddress && stage === 9 ? (
        <DeliveryPanel
          detail={detail}
          tenantId={tenantId}
          archiveRef={
            workflowView?.reviews[8]?.status === "approved"
              ? { artifactId: workflowView.reviews[8].artifactId, version: workflowView.reviews[8].version }
              : null
          }
          latestReply={latestSpecialistMessage}
          finished={!!workflowView?.done}
          onAccept={acceptDelivery}
          onRejectSendBack={() => void sendBack(8)}
          panes={panesWith}
        />
      ) : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
/** Carries out, after render, a decision the render made. */
function OnMount({ action }: { action: () => void }) {
  useMountEffect(action);
  return null;
}

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
      description="What stages 1 to 4 agreed, gathered into the one document the plan is written against. The plan cites its ids."
      status={<StateLabel tone="info">Version {node.version}</StateLabel>}
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
