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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiFailure,
  createHubTransport,
  STAGE_DRAFT_KIND,
  type ActiveModel,
  type ArtifactNode,
  type ProjectDetail,
  type StageTurn,
} from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { markerAlreadySent } from "../../decision-notify.ts";
import { shouldFallbackRefetch, subscribeMailbox } from "../../mailbox-events.ts";
import { Markdown } from "../../markdown.jsx";
import { AudiencePackages } from "../audiences.jsx";
import { DesignFeedbackView } from "../design.jsx";
import { Tabs, Textarea } from "@corbits/react-ui";
import { Banner, Button, Screen, StateLabel, stageName, versionDigest } from "../../components.jsx";
import { Dictated } from "../../dictation.jsx";
import { SendBackPicker, defaultTarget } from "../send-back.jsx";
import { STAGE_GOAL } from "./gate.jsx";
import { DeliveryPanel } from "./delivery.jsx";
import { StageConversation } from "./thread.jsx";
import { StageDocument } from "./document.jsx";
import { Preparing } from "./preparing.jsx";
import { BuildPanel, parsePublishedBundle } from "./build.jsx";
import { TargetPicker, targetOpeningLine } from "./freeze.jsx";
import { deliveryOpeningLine, parseDeliveryManifest } from "./delivery-opening.ts";
import { EstimateView } from "./estimate.jsx";
import { workspaceGuidance } from "./guidance.js";
import { describeFailure } from "./failure-message.ts";
import {
  applyWithdrawn,
  parseWithdrawnTurns,
  pendingTurn,
  WITHDRAWN_TURNS_KIND,
  type WithdrawnMark,
} from "../../withdrawn-turns.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { approveStage, digestOf, ensureReviewOpen, reviewableArtifact, sendBack as sendBackDecision } from "../../stage-approval.ts";
import { frozenSummaryLine, stageEvidence, stageRefusalMessage } from "../../stage-evidence.ts";
import type { ReviewState, Stage7Evidence } from "@solutions-builder/app/project-workflow/contracts";
import type { FoldedFeedback } from "@solutions-builder/app/project-state";

export { StageDocument, DocumentBody } from "./document.jsx";
export { ApprovalsRecord, STAGE_GOAL } from "./gate.jsx";

const LAST_STAGE = 9;
/** Stages whose draft is prose read in the two-pane document, rather than
 * one of the specialised panels (design, audiences, build) or the final
 * decisions stage. */
const DOCUMENT_STAGES = new Set([1, 2, 3, 6, 7]);

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

/**
 * Stage 8's approved build archive, read straight off the workflow's own
 * recorded review (CL-8687/#496 follow-up) -- the review names the exact
 * artifact/version that was approved, never the newest node of a kind.
 */
function approvedStage8Archive(nodes: readonly ArtifactNode[], review: ReviewState | undefined): ArtifactNode | null {
  if (!review || review.status !== "approved") return null;
  return nodes.find((node) => node.artifactId === review.artifactId && node.version === review.version) ?? null;
}

/**
 * The delivery manifest `publish_workspace` uploaded alongside a build
 * archive, resolved from the archive's OWN metadata -- they are written by
 * the same call, sharing the same `variant` (`attempt-<n>`), rather than by
 * scanning for the newest `delivery_manifest` node at stage 8 (which could
 * belong to a different, unapproved attempt).
 */
function manifestCompanionOf(nodes: readonly ArtifactNode[], archive: ArtifactNode): ArtifactNode | null {
  const candidates = nodes.filter(
    (node) => node.kind === "delivery_manifest" && node.stage === 8 && node.variant === archive.variant && node.supersededByNodeId === null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, node) => (node.createdAt > latest.createdAt ? node : latest));
}

/**
 * Stage 9's opening mail (defect 3, CL-8723 follow-up): the delivery
 * manifest `publish_workspace` uploaded alongside the approved build
 * archive, read back and rendered into the exact text the
 * delivery-verifier's prompt promises, plus the build-engineer's own latest
 * status reply as "the checks stage 8 declared". Self-contained (reads
 * stage 8's own thread and the manifest artifact itself) so it produces the
 * identical opening whether called right after `approve()` or rebuilt on a
 * page reload. `archiveRef` is stage 8's approved review -- the workflow's
 * own record, never re-derived from the artifact graph.
 */
async function composeStage9Opening(deps: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly nodes: readonly ArtifactNode[];
  readonly archiveRef: { readonly artifactId: string; readonly version: number } | null;
  readonly fallbackBuildStatusBody?: string;
}): Promise<string> {
  const archiveNode = deps.archiveRef
    ? (deps.nodes.find((node) => node.artifactId === deps.archiveRef!.artifactId && node.version === deps.archiveRef!.version) ?? null)
    : null;
  const manifestNode = archiveNode ? manifestCompanionOf(deps.nodes, archiveNode) : null;
  let manifestRef: Parameters<typeof deliveryOpeningLine>[0] = null;
  if (manifestNode) {
    try {
      const result = await api.artifactContent(deps.tenantId, manifestNode.id);
      const parsed = parseDeliveryManifest(result.content);
      if (parsed) manifestRef = { artifactId: manifestNode.artifactId, version: manifestNode.version, content: parsed };
    } catch {
      // No manifest could be read — deliveryOpeningLine's null branch says so.
    }
  }
  let buildStatusBody = deps.fallbackBuildStatusBody ?? "";
  try {
    const stage8 = await api.stageAgentStatus(deps.projectId, 8);
    if (stage8) {
      const messages = await api.readStageThread(deps.tenantId, [stage8.address]);
      const lastAgent = [...messages].reverse().find((message) => message.author === "agent");
      if (lastAgent) buildStatusBody = lastAgent.body;
    }
  } catch {
    // Keep the fallback (or empty) body — deliveryOpeningLine still sends something.
  }
  return deliveryOpeningLine(manifestRef, buildStatusBody || "No build status text was found.");
}

export function StageWorkspace({
  detail,
  tenantId,
  onChanged,
  onOpenSettings,
  draftOpen = true,
  onOpenDecisions,
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
}) {
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<
    import("../../client.js").Remediation | undefined
  >(undefined);

  // Which model the project's specialists are actually drafting with, read
  // the same way `specialist-deploy.ts` resolves one to deploy against (the
  // tenant's first non-disabled offering) so this never drifts from what a
  // specialist is really running on. `undefined` while unresolved, `null`
  // once resolved to nothing connected.
  const [activeModel, setActiveModel] = useState<ActiveModel | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api
      .activeModel()
      .then((value) => {
        if (!cancelled) setActiveModel(value ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id]);

  // The project workflow (CL-8721) is the ONLY authority for a stage's
  // current position (CL-8687): `workflowView.stage`. There is no artifact-
  // derived fallback -- while the view is still loading, `stage` stays
  // unresolved (see `workflowResolved`) rather than guessing, so the person
  // never sees a stage briefly flash to something the workflow never said.
  // Once the workflow has failed to start or load, `openingFailed` drives
  // the "could not be read" state below instead of a guessed stage.
  const [workflowView, setWorkflowView] = useState<ProjectWorkflowView | null>(null);
  const [workflowStartError, setWorkflowStartError] = useState<string | null>(null);
  const [workflowViewFailed, setWorkflowViewFailed] = useState(false);
  const [workflowAttempt, setWorkflowAttempt] = useState(0);
  const workflowResolved = workflowView !== null;
  const openingFailed = workflowStartError !== null || workflowViewFailed;
  const stage = workflowView?.stage ?? 1;

  const retryOpening = () => {
    setWorkflowStartError(null);
    setWorkflowViewFailed(false);
    setWorkflowAttempt((attempt) => attempt + 1);
  };

  const loadWorkflowView = useCallback(async () => {
    const view = await api.projectWorkflowView(detail.project.id).catch(() => null);
    if (view && view.stage >= 1) setWorkflowView(view);
    return view;
  }, [detail.project.id]);

  // True only while a workflow-view re-read was triggered by something the
  // person just did or that just landed (`refreshWorkflow` below) — never by
  // the routine backstop poll, which would otherwise flicker this on and off
  // every few seconds regardless of activity. Lets the Approve button below
  // tell "refreshing" apart from "not allowed": a stale, disabled button with
  // no explanation is exactly what stranded the person at stage 5.
  const [refreshingAfterAction, setRefreshingAfterAction] = useState(false);

  // The ONE place anything that can change the workflow view's verdict goes
  // through — every stage panel and every action in this file calls this
  // instead of touching `loadWorkflowView`/`onChanged` separately, so there is
  // exactly one refresh path to reason about. Re-reads the view and then
  // tells the parent (`reloadDetail`) the project's artifacts may have
  // changed too.
  const refreshWorkflow = useCallback(async () => {
    setRefreshingAfterAction(true);
    try {
      await loadWorkflowView();
    } finally {
      setRefreshingAfterAction(false);
    }
    onChanged();
  }, [loadWorkflowView, onChanged]);

  // Deployed/triggered once per project, then read on mount and re-read.
  // `ensureProjectWorkflow` and the first `projectWorkflowView` read are each
  // reported on their own terms, so a failure of either says specifically
  // what did not start rather than a generic error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.ensureProjectWorkflow(detail.project.id);
      } catch (cause) {
        if (!cancelled) setWorkflowStartError(describeFailure(cause));
        return;
      }
      let view: ProjectWorkflowView | null;
      try {
        view = await api.projectWorkflowView(detail.project.id);
        // A just-triggered run reports stage 0 until its first state lands.
        for (let tries = 0; view && view.stage < 1 && tries < 120 && !cancelled; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          view = await api.projectWorkflowView(detail.project.id);
        }
        if (view && view.stage < 1) throw new Error("the project workflow did not start");
      } catch {
        if (!cancelled) setWorkflowViewFailed(true);
        return;
      }
      if (cancelled) return;
      setWorkflowView(view);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.project.id, workflowAttempt]);

  // Backstop poll, since the workflow's own decisions do not land on the
  // tenant mailbox stream and so cannot rely on `subscribeMailbox`'s nudge
  // alone. 5s — the same cadence `app.tsx`'s own `refresh()` polls the
  // decision queue and project list at — so a missed nudge costs at most one
  // poll tick, not a whole stage sitting stale (the live defect this fixes:
  // a 20s window read as "a whole stage behind").
  useEffect(() => {
    const timer = setInterval(() => void loadWorkflowView(), 5_000);
    return () => clearInterval(timer);
  }, [loadWorkflowView]);

  // The specialist for this project's stage: deployed lazily the first time
  // the stage is opened (CL-8612 contract v6 — one mail agent per stage,
  // never a lifecycle workflow run). `agentAddress` is the single source of
  // truth for "the agent is known" — the composer and every stage panel key
  // off it directly rather than a separate readiness flag, so there is no
  // window where the address is known but something built on top of it is
  // still disabled.
  // Carries the stage the address was resolved for, so a render where
  // `stage` has already advanced but the previous stage's deployment is
  // still in flight (or already resolved) never leaks that stale address
  // into the opening-send effect below (CL-8649).
  const [agent, setAgent] = useState<{ stage: number; address: string } | null>(null);
  // The hub's own message for a failed deployment, shown verbatim rather
  // than left to the waiting UI to imply it's still in progress (CL-8612's
  // 502 case: the workspace used to sit on "Starting…" forever).
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentAttempt, setAgentAttempt] = useState(0);
  useEffect(() => {
    // The real stage has to be known before a specialist is deployed for it
    // — never for the artifact-derived fallback while the workflow view is
    // still loading (CL-8721).
    if (!workflowResolved) return;
    let cancelled = false;
    const requestedStage = stage;
    setAgentError(null);
    api
      .ensureStageAgent(detail.project.id, requestedStage)
      .then((deployment) => {
        if (!cancelled) setAgent({ stage: requestedStage, address: deployment.address });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAgentError(describeFailure(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id, stage, workflowResolved, agentAttempt]);
  const agentAddress = agent?.stage === stage ? agent.address : null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Tracks which address `messages` actually reflects, so the opening-send
  // effect below never judges a fresh address's thread empty off stale data
  // still held over from the previous address (CL-8656).
  const [threadLoadedFor, setThreadLoadedFor] = useState<string | null>(null);
  const lastLoadAt = useRef(0);
  const loadThread = useCallback(async () => {
    if (!agentAddress) return;
    const loadedAddress = agentAddress;
    try {
      const result = await api.readStageThread(tenantId, [agentAddress]);
      setMessages(result);
      setThreadLoadedFor(loadedAddress);
      lastLoadAt.current = Date.now();
    } catch (cause) {
      setError(
        `The conversation for this stage could not be read: ${
          cause instanceof ApiFailure ? cause.detail.message : String(cause)
        }`,
      );
    }
  }, [agentAddress, tenantId]);

  // A new address (fresh run replacing a released one, CL-8654) starts with
  // no known thread state: clear the previous address's messages rather than
  // let them linger until the next poll resolves.
  useEffect(() => {
    setMessages([]);
    setThreadLoadedFor(null);
  }, [agentAddress]);

  // Stop's durable marker: one per-project artifact, read with the rest of
  // this project's artifacts so a withdrawn turn stays withdrawn across a
  // refresh or a second browser (CL-8695).
  const withdrawnNode = useMemo(
    () => detail.nodes.find((node) => node.kind === WITHDRAWN_TURNS_KIND) ?? null,
    [detail.nodes],
  );
  const [withdrawnMarks, setWithdrawnMarks] = useState<WithdrawnMark[]>([]);
  useEffect(() => {
    if (!withdrawnNode) {
      setWithdrawnMarks([]);
      return;
    }
    let cancelled = false;
    void api
      .artifactContent(tenantId, withdrawnNode.id)
      .then((result) => {
        if (!cancelled) setWithdrawnMarks(parseWithdrawnTurns(result.content));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [withdrawnNode?.id, tenantId]);
  const withdrawnIds = useMemo(
    () => new Set(withdrawnMarks.filter((mark) => mark.stage === stage).map((mark) => mark.messageId)),
    [withdrawnMarks, stage],
  );
  // The fold runs before guidance ever sees the thread, so a reply Stop hid
  // can never be read back as the current draft or the open question.
  const foldedMessages = useMemo(() => applyWithdrawn(messages, withdrawnIds), [messages, withdrawnIds]);
  const pending = useMemo(() => pendingTurn(foldedMessages, withdrawnIds), [foldedMessages, withdrawnIds]);

  // Refetched on a nudge from the tenant mailbox stream (CL-8694) — the
  // specialist's reply lands as a `create` event the moment it's sent. A 20s
  // fallback poll covers the stream being down, so a dropped connection
  // never strands the person waiting on a reply that already arrived.
  useEffect(() => {
    if (!agentAddress) return;
    void loadThread();
    // The workflow's own decisions (an approval landing, a send-back) land as
    // run events on this same tenant mailbox stream — the nudge that already
    // wakes the thread read is just as much a reason to re-read the workflow
    // view, so both go on every nudge rather than leaving the view to the
    // slower backstop poll alone.
    const subscription = subscribeMailbox(tenantId, () => {
      void loadThread();
      void loadWorkflowView();
    });
    const timer = setInterval(() => {
      const open = subscription.isOpen();
      const msSinceLastLoad = Date.now() - lastLoadAt.current;
      if (shouldFallbackRefetch({ open, msSinceLastLoad })) {
        void loadThread();
        void loadWorkflowView();
      }
    }, 20_000);
    return () => {
      clearInterval(timer);
      subscription.unsubscribe();
    };
  }, [agentAddress, tenantId, loadThread, loadWorkflowView]);

  // Same cadence, re-checking the agent itself rather than its thread: two
  // sessions racing to open this stage can each deploy a specialist, the hub
  // releases the loser, and a session that memoised the loser's address
  // would otherwise mail into the void forever (CL-8654). When the live pick
  // has moved to a different deployment, follow it.
  useEffect(() => {
    if (!agentAddress) return;
    const recheck = () => {
      void api
        .stageAgentStatus(detail.project.id, stage)
        .then((current) => {
          if (current && current.address !== agentAddress) setAgent({ stage, address: current.address });
        })
        .catch(() => {});
    };
    const timer = setInterval(recheck, 3_000);
    return () => clearInterval(timer);
  }, [agentAddress, detail.project.id, stage]);

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  // What Stop put back into the box: the composer above for a plain-chat
  // stage, and this seed for the document composer's own local state.
  const [stopSeed, setStopSeed] = useState<{ text: string; at: number } | null>(null);
  const stopTurn = async () => {
    if (!pending) return;
    const withdrawn = pending;
    setComposer(withdrawn.body);
    setStopSeed({ text: withdrawn.body, at: Date.now() });
    try {
      await api.withdrawTurn(detail.project.id, tenantId, { messageId: withdrawn.id, stage });
      setWithdrawnMarks((marks) => [...marks, { messageId: withdrawn.id, stage, at: new Date().toISOString() }]);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };
  // Stage 7 only: the build target chosen at freeze time. Reset whenever the
  // stage changes so an earlier project's choice never leaks into a new one.
  const [chosenTarget, setChosenTarget] = useState<string | null>(null);
  useEffect(() => {
    setChosenTarget(null);
  }, [stage]);

  // Stage 1's own opening problem statement, read straight off its
  // lifecycle deployment (`api.projectOpening`, scoped to the workspace
  // tenant `createProject` actually deployed it into) rather than
  // `detail.opening` — `loadProjectView`'s own fold reads that scoped to
  // the project's own child tenant, where that deployment never lived, and
  // so always comes back null, silently starving the auto-send below.
  const [opening, setOpening] = useState<{ body: string } | null | undefined>(undefined);
  useEffect(() => {
    if (stage !== 1) return;
    let cancelled = false;
    api
      .projectOpening(detail.project.id)
      .then((result) => {
        if (!cancelled) setOpening(result);
      })
      .catch(() => {
        if (!cancelled) setOpening(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id, stage]);

  // The stage-1 opening problem statement is the first message of that
  // stage's thread, sent once. A later stage's opening is instead the just-
  // approved draft, sent from `approve()` below the moment the stage
  // advances — this only fires the very first message of a fresh thread.
  // Set only once the send is confirmed (either this tab's own send landed,
  // or another tab's already had, per the marker check below) — never
  // beforehand, so a send that throws is retried rather than treated as done.
  const openedRef = useRef<string | null>(null);
  // Guards a single key against a second concurrent attempt from this same
  // component (an unrelated dependency of the effect below changing while an
  // attempt is still in flight) — a narrower, synchronous version of what the
  // marker already guards across tabs and reloads.
  const openingInFlightRef = useRef<string | null>(null);
  // A key already auto-retried once, so a second failure surfaces instead of
  // retrying forever.
  const openingAutoRetriedRef = useRef<string | null>(null);
  const [pendingOpening, setPendingOpening] = useState<{ stage: number; body: string } | null>(null);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const [openingRetryAttempt, setOpeningRetryAttempt] = useState(0);

  // Belt-and-braces: `key={detail.project.id}` on this component in App.tsx
  // already remounts it per project, resetting all of the above. This makes
  // sure the previous project's workflow view, pending send, and
  // opened-thread marker never leak into a newly opened one even if that
  // remount ever regresses.
  useEffect(() => {
    setWorkflowView(null);
    setWorkflowStartError(null);
    setWorkflowViewFailed(false);
    setPendingOpening(null);
    setOpeningError(null);
    openedRef.current = null;
    openingInFlightRef.current = null;
    openingAutoRetriedRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.project.id]);

  // Fallback source for a stage > 1 opening when `pendingOpening` was never
  // set in this mounted component — a reload, a re-opened project, or the
  // stage cursor advancing some other way (`approve()` only ever writes
  // `pendingOpening` in memory, so it never survives any of those). The
  // previous stage's approved review IS the input to this one (CL-8687): its
  // exact `artifactId`/`version`, read straight off the workflow's own
  // record — never re-derived by scanning nodes for a kind. No approved
  // review at N-1 means there is no input yet.
  const previousApproved = useMemo(() => {
    if (stage <= 1 || !workflowView) return null;
    const review = workflowView.reviews[stage - 1];
    if (!review || review.status !== "approved") return null;
    return { artifactId: review.artifactId, version: review.version };
  }, [workflowView, stage]);

  useEffect(() => {
    if (!agentAddress || agent?.stage !== stage) return;
    // Wait for the thread read to land for this exact address before judging
    // it empty — otherwise a fresh run's still-stale `messages` from the
    // previous address could either wrongly suppress or wrongly trigger the
    // opening send (CL-8656).
    if (threadLoadedFor !== agentAddress || messages.length > 0) return;
    const key = `${detail.project.id}:${stage}:${agentAddress}`;
    if (openedRef.current === key || openingInFlightRef.current === key) return;

    let cancelled = false;
    // Server-visible dedup (defect: duplicate opening mail across two tabs)
    // — the same `[marker]`-in-Sent-folder check `decision-notify.ts` uses,
    // keyed to this project's stage rather than a decision id, so two tabs
    // that both load an empty stage N+1 thread never both send its opening.
    const marker = `[opening:${detail.project.id}:${stage}]`;
    const dispatchOpening = (body: string) => {
      if (cancelled || openedRef.current === key || openingInFlightRef.current === key) return;
      openingInFlightRef.current = key;
      void markerAlreadySent(createHubTransport(), tenantId, marker)
        .then((already) => {
          if (cancelled) return undefined;
          if (already) {
            openedRef.current = key;
            return loadThread();
          }
          return api
            .sendStageMail(tenantId, agentAddress, { body, subject: `${marker} ${stageName(stage)}` })
            .then(() => {
              if (cancelled) return undefined;
              // Marked as opened only now that the send is confirmed —
              // a throw above skips this, so a failed send is retried
              // rather than silently treated as sent.
              openedRef.current = key;
              setOpeningError(null);
              return loadThread();
            });
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setOpeningError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
          if (openingAutoRetriedRef.current !== key) {
            openingAutoRetriedRef.current = key;
            setTimeout(() => {
              if (!cancelled) setOpeningRetryAttempt((attempt) => attempt + 1);
            }, 3_000);
          }
        })
        .finally(() => {
          if (openingInFlightRef.current === key) openingInFlightRef.current = null;
        });
    };

    if (stage === 1) {
      if (opening?.body) dispatchOpening(opening.body);
      return;
    }
    if (pendingOpening?.stage === stage) {
      dispatchOpening(pendingOpening.body);
      return;
    }
    // Stage 9 never reads the raw stage-8 artifact (it may be the binary
    // archive itself): its opening is always composed from the manifest and
    // stage 8's own status reply (defect 3).
    if (stage === 9) {
      const review = workflowView?.reviews[8];
      const archiveRef = review?.status === "approved" ? { artifactId: review.artifactId, version: review.version } : null;
      void composeStage9Opening({ tenantId, projectId: detail.project.id, nodes: detail.nodes, archiveRef }).then(dispatchOpening);
      return () => {
        cancelled = true;
      };
    }
    if (!previousApproved) return;
    void api
      .artifactContent(tenantId, previousApproved.artifactId)
      .then((result) => {
        if (!result.content) return;
        // Stage 8's opening also names the frozen target — lost on reload
        // since `pendingOpening` never survives one (defect 4). Rebuilt from
        // the workflow view's own `freeze`, set the moment stage 7 is
        // approved and cleared only by a send-back to stage <= 7.
        const body =
          stage === 8 && workflowView?.freeze
            ? `${targetOpeningLine(workflowView.freeze.target)}\n\n${frozenSummaryLine({
                target: workflowView.freeze.target,
                frozen: workflowView.freeze.frozen,
              })}\n\n${result.content}`
            : result.content;
        dispatchOpening(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    agentAddress,
    agent,
    messages.length,
    threadLoadedFor,
    stage,
    detail.project.id,
    detail.nodes,
    opening,
    pendingOpening,
    previousApproved,
    tenantId,
    loadThread,
    workflowView,
    openingRetryAttempt,
  ]);

  // Defect 5: a send-back into stage 8 lands on a thread that already has
  // history, so the opening-send effect above (gated on an EMPTY thread)
  // never fires — the build specialist sees nothing telling it the stage
  // came back. Sends one resume cue instead, keyed on the workflow's own
  // send-back decision id (embedded in the message body) so a reload never
  // repeats it.
  useEffect(() => {
    if (stage !== 8 || !agentAddress || agent?.stage !== 8) return;
    if (threadLoadedFor !== agentAddress || messages.length === 0) return;
    const lastSendBack = [...(workflowView?.decisions ?? [])]
      .reverse()
      .find((decision) => decision.kind === "send_back" && decision.accepted && decision.targetStage === 8);
    if (!lastSendBack) return;
    const marker = lastSendBack.decisionId;
    if (messages.some((message) => message.body.includes(marker))) return;
    const reason = lastSendBack.reason ?? "revise and resubmit.";
    const body = `This stage was sent back: ${reason} Continue in a new attempts/<n+1>/ directory — the next empty one — rather than reusing the last attempt. [ref:${marker}]`;
    void api
      .sendStageMail(tenantId, agentAddress, { body })
      .then(() => loadThread())
      .catch(() => {});
  }, [stage, agentAddress, agent, threadLoadedFor, messages, workflowView, tenantId, loadThread]);

  const send = async (body: string) => {
    if (!agentAddress || body.trim().length === 0) return;
    setSending(true);
    setError(null);
    setRemediation(undefined);
    try {
      await api.sendStageMail(tenantId, agentAddress, { body });
      await loadThread();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setSending(false);
    }
  };

  // Withdrawn turns are folded out before anything below reads the thread,
  // so a reply Stop hid can never surface as the latest turn, the draft, or
  // the open question (CL-8695).
  const latestSpecialistMessage = [...foldedMessages].reverse().find((message) => message.author === "agent") ?? null;
  // Mail has no separate draft record before approval. Keep a substantial
  // draft separate from the latest conversational turn so an acknowledgement
  // or a follow-up question never replaces the document being reviewed.
  const guidance = useMemo(() => workspaceGuidance(stage, foldedMessages), [stage, foldedMessages]);
  const draftMessage = guidance.draft;
  const reviewMessage = DOCUMENT_STAGES.has(stage) ? draftMessage : latestSpecialistMessage;

  // Mail turns as StageDocument's turn shape: it wants who spoke and what
  // was said, nothing this contract tracks beyond that (no per-turn quotes
  // or result-node bookkeeping under mail-chat).
  const turns: StageTurn[] = useMemo(
    () =>
      foldedMessages.map((message) => ({
        id: message.id,
        role: message.author === "me" ? "human" : "specialist",
        body: message.body,
        quotes: [],
        resultNodeId: null,
        questions: null,
        createdAt: message.at,
      })),
    [foldedMessages],
  );

  // This stage's approved versions, plus the specialist's latest unpersisted
  // reply as the version being read right now — the same stand-in
  // `DesignPanel` uses below for stage 4's not-yet-approved mockup, since
  // nothing writes an artifact for a stage's draft before it is approved.
  const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
  const approvedVersions = useMemo(
    () =>
      detail.nodes
        .filter((node) => node.stage === stage && draftKind !== null && node.kind === draftKind)
        .sort((left, right) => left.version - right.version),
    [detail.nodes, stage, draftKind],
  );
  const draftDocNode: ArtifactNode | null = useMemo(() => {
    if (!draftMessage || draftKind === null) return null;
    return {
      id: `reply:${draftMessage.id}`,
      kind: draftKind,
      variant: null,
      stage,
      title: stageName(stage),
      version: (approvedVersions.at(-1)?.version ?? 0) + 1,
      artifactId: `reply:${draftMessage.id}`,
      contentHash: "",
      sizeBytes: draftMessage.body.length,
      mediaType: "text/markdown",
      createdAt: draftMessage.at,
      supersededByNodeId: null,
      provenance: { producer: "specialist" },
    };
  }, [draftMessage, draftKind, stage, approvedVersions]);
  const documentVersions = useMemo(
    () => (draftDocNode ? [...approvedVersions, draftDocNode] : approvedVersions),
    [approvedVersions, draftDocNode],
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedVersionId(null);
  }, [stage]);
  const activeNode =
    documentVersions.find((version) => version.id === selectedVersionId) ?? documentVersions.at(-1) ?? null;
  const newerVersion =
    activeNode ? documentVersions.find((version) => version.version > activeNode.version) ?? null : null;

  const [activeContent, setActiveContent] = useState("");
  useEffect(() => {
    if (!activeNode) {
      setActiveContent("");
      return;
    }
    if (activeNode.id === draftDocNode?.id) {
      setActiveContent(draftMessage?.body ?? "");
      return;
    }
    let cancelled = false;
    void api
      .artifactContent(tenantId, activeNode.id)
      .then((result) => {
        if (!cancelled) setActiveContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setActiveContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNode?.id, tenantId]);

  /**
   * The stage 8 build specialist's `publish_workspace` fallback result, when
   * its reply carries one: `{fileName, mediaType, dataUri, sizeBytes}`,
   * either as the whole message body or inside a fenced code block.
   * Anything else (a plain status update, or the real-upload result shape)
   * is not a fallback bundle, so approve() records the real artifact
   * `publish_workspace` already uploaded instead of persisting anything.
   */
  const publishedBundle = useMemo(
    () => (stage === 8 ? parsePublishedBundle(latestSpecialistMessage?.body) : null),
    [stage, latestSpecialistMessage],
  );

  const stageApprovalDeps = useMemo(
    () => ({
      view: (projectId: string) => api.projectWorkflowView(projectId),
      decide: (projectId: string, decision: Record<string, unknown>) => api.decide(projectId, decision),
      now: () => new Date().toISOString(),
    }),
    [],
  );

  /**
   * This stage's reviewable version, as `{artifactId, version, sha256}` --
   * the browser's one legitimate job (it is the only party that may read an
   * artifact): find or persist the material, never judge whether it is
   * "ready". Persists a chat draft as a new version when nothing else wrote
   * one yet (`persistStageDraft`/`persistBuildEvidence`); returns null when
   * there is nothing reviewable yet.
   *
   * Stage 8 is different (CL-8723): `publish_workspace` already uploaded the
   * build archive as a real artifact, so `reviewableArtifact` finds it
   * directly and no browser write happens at all — the reference is the
   * artifact's own id/version/`contentSha256`, not a hash of chat prose.
   * Every other stage (and stage 8 before the tool has run) still persists
   * the specialist's latest reply as its draft.
   *
   * Stage 7 is also the freeze: the chosen target rides along in the same
   * artifact write (`sb.target`), so `approve()`'s opening mail can quote it
   * without re-deriving it from the plan.
   */
  const resolveReviewRef = useCallback(async (): Promise<{ artifactId: string; version: number; sha256: string } | null> => {
    if (!reviewMessage || draftKind === null) return null;
    const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft: publishedBundle ?? reviewMessage });
    if (reviewable.status === "found") {
      return {
        artifactId: reviewable.node.artifactId,
        version: reviewable.node.version,
        sha256: reviewable.node.contentSha256 ?? (await digestOf(reviewMessage.body)),
      };
    }
    if (reviewable.status !== "persist_needed") return null;
    const persisted = publishedBundle
      ? await api.persistBuildEvidence(detail.project.id, publishedBundle, materials)
      : await api.persistStageDraft(
          detail.project.id,
          stage,
          reviewMessage.body,
          materials,
          stage === 7 ? (chosenTarget ?? undefined) : undefined,
        );
    const version = Number(persisted.contentHash.slice(persisted.contentHash.lastIndexOf("@") + 1));
    const sha256 = await digestOf(reviewMessage.body);
    return { artifactId: persisted.artifactId, version, sha256 };
  }, [reviewMessage, draftKind, detail.nodes, detail.project.id, stage, publishedBundle, chosenTarget]);

  // Opens the review the moment this stage's material is ready, rather than
  // at the instant of approval -- the project workflow (`allowed.approve`)
  // is the only gate on the Approve button, and a review that only opens
  // inside `approve()` would leave `allowed.approve` false right up until
  // approval, making it useless as a button gate (CL-8687 follow-up). Skips
  // stage 7 until a target is chosen -- there is nothing reviewable to name
  // yet -- and keys on the resolved material's id/version so a fresh draft
  // (a revision) opens its own review rather than being silently skipped as
  // "already tried". Idempotent under reload/two tabs: `ensureReviewOpen`
  // itself no-ops once the view already shows the same ref open.
  const ensuringReviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workflowView || workflowView.done || stage >= LAST_STAGE) return;
    if (stage === 7 && !chosenTarget) return;
    if (!reviewMessage || draftKind === null) return;
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft: publishedBundle ?? reviewMessage });
    if (reviewable.status === "none") return;
    const key =
      reviewable.status === "found"
        ? `${String(stage)}:${reviewable.node.artifactId}@${String(reviewable.node.version)}`
        : `${String(stage)}:draft:${reviewMessage.id}`;
    if (ensuringReviewKeyRef.current === key) return;
    ensuringReviewKeyRef.current = key;
    void (async () => {
      try {
        const ref = await resolveReviewRef();
        if (!ref) return;
        const sameAsOpen =
          workflowView.openReview !== null &&
          workflowView.openReview.artifactId === ref.artifactId &&
          workflowView.openReview.version === ref.version &&
          workflowView.openReview.sha256 === ref.sha256;
        if (sameAsOpen) return;
        await ensureReviewOpen(stageApprovalDeps, { projectId: detail.project.id, stage, ref });
        await refreshWorkflow();
      } catch {
        // Left as the sentinel: a later render (a poll, a reply) retries.
        ensuringReviewKeyRef.current = null;
      }
    })();
  }, [workflowView, stage, chosenTarget, reviewMessage, draftKind, detail.nodes, detail.project.id, publishedBundle, resolveReviewRef, stageApprovalDeps, refreshWorkflow]);

  /**
   * Sends the workflow's `approve` decision for this stage's already-open
   * review (`approveStage` opens one itself, belt-and-braces, if somehow
   * none is), and waits for it to land before treating the stage as
   * advanced (CL-8687: the workflow is the process authority, not this
   * write). On a refusal the error banner shows the reason and the next
   * stage's opening mail is never sent.
   */
  const approve = async () => {
    if (!reviewMessage || stage >= LAST_STAGE) return;
    if (stage === 7 && !chosenTarget) return;
    setApproving(true);
    setError(null);
    setRemediation(undefined);
    try {
      // The normal path: a review is already open (the auto-open effect put
      // it there the moment this stage's material appeared), so its ref is
      // read straight off the view rather than resolved/persisted again --
      // resolving it a second time here would persist a second, redundant
      // draft version every approval. `resolveReviewRef` is the fallback for
      // the rare case nothing is open yet (`approveStage` also falls back to
      // opening one itself, belt-and-braces).
      const ref = workflowView?.openReview
        ? { artifactId: workflowView.openReview.artifactId, version: workflowView.openReview.version, sha256: workflowView.openReview.sha256 }
        : await resolveReviewRef();
      if (!ref) return;
      const evidence = await stageEvidence(stage, {
        projectId: detail.project.id,
        tenantId,
        nodes: detail.nodes,
        chosenTarget,
        workflowView,
        stakeholders: api.stakeholders,
        audienceDecisions: (tid, nodeId) => api.audienceDecisions(tid, nodeId),
      });
      const result = await approveStage(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        ref,
        evidence,
      });
      if (!result.ok) {
        setError(`This stage's approval was refused: ${stageRefusalMessage(result.reason)}`);
        await refreshWorkflow();
        return;
      }
      setWorkflowView((current) => (current ? { ...current, stage: result.stage } : current));
      await refreshWorkflow();
      const openingBody =
        stage === 7 && chosenTarget
          ? `${targetOpeningLine(chosenTarget)}\n\n${frozenSummaryLine(evidence as Stage7Evidence)}\n\n${reviewMessage.body}`
          : stage === 8
            ? await composeStage9Opening({
                tenantId,
                projectId: detail.project.id,
                nodes: detail.nodes,
                archiveRef: { artifactId: ref.artifactId, version: ref.version },
                fallbackBuildStatusBody: reviewMessage.body,
              })
            : reviewMessage.body;
      setPendingOpening({ stage: result.stage, body: openingBody });
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setApproving(false);
    }
  };

  /**
   * Stage 9's Accept (defect 2): `DeliveryPanel`'s Accept button only ever
   * resolved the hub's `deliver` tool approval — a stock tool-call approval
   * (CL-8566), not the project workflow's own stage gate. Nothing sent the
   * workflow its stage 9 `approve` decision, so `contracts.ts`'s `done`
   * (set only when an `approve` lands on the last stage) never fired and the
   * project never finished. Called AFTER the tool approval succeeds
   * (`delivery.jsx`'s own `decide("approve")`); the reference is the
   * `delivery_manifest` companion of stage 8's approved review (the
   * workflow's own record of what stage 9 actually reviewed) — falling back
   * to the archive itself if no manifest companion exists (e.g. the
   * data-URI fallback path).
   */
  const acceptDelivery = async () => {
    setApproving(true);
    setError(null);
    try {
      const archiveNode = approvedStage8Archive(detail.nodes, workflowView?.reviews[8]);
      const evidenceNode = archiveNode ? (manifestCompanionOf(detail.nodes, archiveNode) ?? archiveNode) : null;
      if (!evidenceNode) {
        setError("No build evidence is recorded for this project yet — delivery cannot be finished.");
        return;
      }
      const ref = {
        artifactId: evidenceNode.artifactId,
        version: evidenceNode.version,
        sha256: evidenceNode.contentSha256 ?? (await digestOf(evidenceNode.id)),
      };
      const result = await approveStage(stageApprovalDeps, { projectId: detail.project.id, stage: 9, ref });
      if (!result.ok) {
        setError(`Delivery was recorded, but the project workflow refused the final approval: ${stageRefusalMessage(result.reason)}`);
        await refreshWorkflow();
        return;
      }
      await refreshWorkflow();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setApproving(false);
    }
  };

  const [sendTarget, setSendTarget] = useState<number | null>(null);
  const [sendReason, setSendReason] = useState("");
  const [sendingBack, setSendingBack] = useState(false);

  /** Sends this stage back to `target`, through the workflow's own
   *  `send_back` decision — every review at `target` and above is marked
   *  stale, nothing is deleted (`project-workflow/contracts.ts`). */
  const sendBack = async (target: number) => {
    setSendingBack(true);
    setError(null);
    try {
      const result = await sendBackDecision(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        targetStage: target,
        reason: sendReason.trim() || `Sent back from stage ${stage} to stage ${target}.`,
      });
      if (!result.ok) {
        setError(`Send-back was refused: ${result.reason}`);
        return;
      }
      setWorkflowView((current) => (current ? { ...current, stage: result.stage } : current));
      await refreshWorkflow();
      setSendReason("");
      setSendTarget(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setSendingBack(false);
    }
  };

  // The Approve button's ONE gate, for every stage panel: the project
  // workflow's own verdict. Never re-derived from chat messages or artifact
  // presence (CL-8687 follow-up) — those only decide what to name to
  // `open_review` (the auto-open effect above), never whether Approve is
  // clickable.
  const approveAllowed = workflowView?.allowed.approve ?? false;

  const panelReviews = detail.nodes.filter(
    (node) => node.stage === stage && node.kind === "engineering_review",
  );
  const requirements =
    detail.nodes.find((node) => node.stage === stage && node.kind === "product_requirements" && node.supersededByNodeId === null) ??
    null;

  // Neutral until the workflow view says which stage this really is — never
  // the artifact-derived fallback, which for a mid-way project is stage 1
  // and would otherwise flash before the real stage takes over (CL-8721).
  if (!workflowResolved && !openingFailed) {
    return (
      <div className="stage-view">
        <Screen title="Opening the project…" description="Reading where this project's workflow stands." tight>
          <p className="inline-note">This will only take a moment.</p>
        </Screen>
      </div>
    );
  }

  return (
    <div className="stage-view">
      {activeModel ? (
        <p className="inline-note stage-model-line">
          Drafting with {activeModel.providerLabel} · {activeModel.canonicalName}{" "}
          <button type="button" className="link-button" onClick={onOpenSettings}>
            Settings
          </button>
        </p>
      ) : null}

      {workflowView?.done ? (
        <Banner tone="okay" title="This project is delivered — stage 9's approval was recorded and the workflow has finished." />
      ) : null}

      {openingFailed ? (
        <Banner
          tone="error"
          title={
            workflowStartError
              ? `The project workflow could not be started: ${workflowStartError}`
              : "The project workflow could not be read."
          }
          action={{ label: "Try again", onClick: retryOpening }}
        />
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
                    onOpenSettings();
                  },
                },
              }
            : {})}
        />
      ) : null}

      {/* Sending the stage back is offered wherever the person is working,
          folded to a line so it never competes with the review itself. */}
      {stage >= 2 && stage < LAST_STAGE ? (
        <details className="approvals-record send-back">
          <summary>Missed something earlier? Send this stage back…</summary>
          <div className="send-back-body">
            <SendBackPicker
              id="workspace-send-back-target"
              stage={stage}
              target={sendTarget ?? defaultTarget(stage)}
              onChange={setSendTarget}
            />
            <div className="field">
              <label htmlFor="workspace-send-back-reason">What was missed, or what has to change</label>
              <Dictated value={sendReason} onValueChange={setSendReason} align="start">
                <Textarea
                  id="workspace-send-back-reason"
                  value={sendReason}
                  onChange={(event) => setSendReason(event.target.value)}
                  placeholder="Recorded with the send-back, and put in the box at the stage you return to, for the specialist."
                />
              </Dictated>
            </div>
            <div className="action-row">
              <Button loading={sendingBack} onClick={() => void sendBack(sendTarget ?? defaultTarget(stage))}>
                Send back to {stageName(sendTarget ?? defaultTarget(stage))}
              </Button>
            </div>
          </div>
        </details>
      ) : null}

      {!agentAddress && agentError ? (
        <Banner
          tone="error"
          title={`The ${stageName(stage).toLowerCase()} specialist could not be started`}
          action={{ label: "Try again", onClick: () => setAgentAttempt((attempt) => attempt + 1) }}
        >
          {agentError}
        </Banner>
      ) : null}

      {!agentAddress && !agentError ? (
        <Screen title={`Stage ${stage} of 9 · ${stageName(stage)}`} description={STAGE_GOAL[stage]} tight>
          <p className="inline-note">Starting the {stageName(stage).toLowerCase()} specialist…</p>
        </Screen>
      ) : null}

      {agentAddress && openingError ? (
        <Banner
          tone="error"
          title="The opening message could not be sent"
          action={{ label: "Try again", onClick: () => setOpeningRetryAttempt((attempt) => attempt + 1) }}
        >
          {openingError}
        </Banner>
      ) : null}

      {agentAddress ? (
        <div className="stage-guidance" aria-label={guidance.title}>
          <p className="stage-guidance-title">{guidance.title}</p>
          <p className="stage-guidance-detail">{guidance.detail}</p>
          {guidance.question && guidance.question.choices.length > 0 ? (
            <div className="button-row" aria-label="Recorded answer choices">
              {guidance.question.choices.map((choice) => (
                <Button key={choice} variant="ghost" disabled={sending} onClick={() => void send(choice)}>
                  {choice}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {agentAddress && stage === 4 ? (
        <DesignPanel
          detail={detail}
          tenantId={tenantId}
          onChanged={() => void refreshWorkflow()}
          onApprove={approve}
          onRevise={(prompt) => send(prompt)}
          latestReply={latestSpecialistMessage}
          canApprove={approveAllowed}
        />
      ) : null}

      {agentAddress && stage === 5 ? (
        <div className="stage-scroll">
          <AudiencePackages
            detail={detail}
            tenantId={tenantId}
            agentAddress={agentAddress}
            onChanged={() => {
              void refreshWorkflow();
              void loadThread();
            }}
            onApprove={approve}
            approving={approving || refreshingAfterAction}
            canApprove={approveAllowed}
            approveReason={workflowView?.allowed.approveReason ?? null}
            lastRefusal={workflowView?.lastRefusal ?? null}
          />
        </div>
      ) : null}

      {agentAddress && stage === 8 ? (
        <div className="stage-scroll">
          <BuildPanel
            detail={detail}
            tenantId={tenantId}
            onChanged={() => void refreshWorkflow()}
            onOpenSettings={onOpenSettings}
            onApprove={approve}
            approving={approving || refreshingAfterAction}
            canApprove={approveAllowed}
            {...(onOpenDecisions ? { onOpenDecisions } : {})}
          />
        </div>
      ) : null}

      {agentAddress && (requirements || panelReviews.length > 0) ? (
        <div className="stage-companions">
          {requirements ? (
            <ProductRequirements
              node={requirements}
              tenantId={tenantId}
              canRewrite={agentAddress !== null}
              busy={sending}
              onRewrite={() => void send("Write the requirements again, and the plan against them.")}
            />
          ) : null}
          {panelReviews.length > 0 ? <PanelReviews reviews={panelReviews} tenantId={tenantId} /> : null}
        </div>
      ) : null}

      {agentAddress && DOCUMENT_STAGES.has(stage) && !draftMessage ? (
        <>
          <Preparing
            stage={stage}
            busy={messages.length > 0}
            since={[...messages].reverse().find((message) => message.author === "me")?.at ?? null}
          />
          <StageConversation
            stage={stage}
            messages={foldedMessages}
            value={composer}
            onValueChange={setComposer}
            onSend={() => {
              const body = composer;
              setComposer("");
              void send(body);
            }}
            working={sending}
            disabled={!agentAddress}
            placeholder={guidance.question ? "Your answer. Rough is fine." : "Add context or ask for the complete draft…"}
            withdrawnIds={withdrawnIds}
            pending={pending !== null}
            onStop={() => void stopTurn()}
          />
        </>
      ) : null}

      {agentAddress && DOCUMENT_STAGES.has(stage) && draftMessage && activeNode ? (
        <>
          {stage === 7 ? (
            <EstimateView
              body={draftMessage.body}
              chosenTarget={chosenTarget}
              freeze={workflowView?.freeze ?? null}
            />
          ) : null}
          {stage === 7 ? <TargetPicker chosen={chosenTarget} onChange={setChosenTarget} /> : null}
          <StageDocument
            node={activeNode}
            versions={documentVersions}
            content={activeContent}
            tenantId={tenantId}
            turns={turns}
            openQuestion={guidance.question ? { text: guidance.question.text } : null}
            onSelectVersion={setSelectedVersionId}
            onRevise={(message, quotes) => {
              setSelectedVersionId(null);
              const quoted = quotes.map((entry) => `> ${entry.quote}`).join("\n");
              void send(quoted ? `${quoted}\n\n${message}` : message);
            }}
            onAddMaterial={async (files) => {
              await api.attachMaterial(detail.project.id, files);
              void refreshWorkflow();
            }}
            onSubmit={() => void approve()}
            soloApproval={detail.soloApproval}
            canSubmit={approveAllowed}
            busy={sending ? "draft" : approving || refreshingAfterAction ? "submit" : null}
            draftOpen={draftOpen}
            newer={newerVersion}
            live={null}
            seed={stopSeed}
            withdrawnIds={withdrawnIds}
            pending={pending !== null}
            onStop={() => void stopTurn()}
          />
        </>
      ) : null}

      {agentAddress && stage === 9 ? (
        <DeliveryPanel
          detail={detail}
          tenantId={tenantId}
          latestReply={latestSpecialistMessage}
          onAccept={acceptDelivery}
          onRejectSendBack={() => void sendBack(8)}
        />
      ) : null}

      {agentAddress && stage !== 4 && stage !== 5 && stage !== 8 && !DOCUMENT_STAGES.has(stage) ? (
        <>
          <Screen
            title={`Stage ${stage} of 9 · ${stageName(stage)}`}
            description={STAGE_GOAL[stage]}
            status={
              stage >= LAST_STAGE ? null : (
                <Button
                  variant="primary"
                  loading={approving || refreshingAfterAction}
                  disabled={!approveAllowed}
                  onClick={() => void approve()}
                >
                  Approve and continue
                </Button>
              )
            }
            tight
          >
            {latestSpecialistMessage ? (
              <div className="document-body">
                <Markdown source={latestSpecialistMessage.body} />
              </div>
            ) : foldedMessages.length > 0 ? (
              <p className="inline-note">Waiting on the specialist's first reply…</p>
            ) : (
              <p className="inline-note">Say what you'd like below to start the conversation.</p>
            )}
          </Screen>
          <StageConversation
            stage={stage}
            messages={foldedMessages}
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
            pending={pending !== null}
            onStop={() => void stopTurn()}
          />
        </>
      ) : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
function DesignPanel({
  detail,
  tenantId,
  onChanged,
  onApprove,
  onRevise,
  latestReply,
  canApprove,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** Persists the specialist's latest reply and advances to stage 5. */
  onApprove: () => Promise<unknown>;
  /** Sends free-form feedback text to the stage-4 specialist's mail thread. */
  onRevise: (prompt: string) => Promise<unknown>;
  /** The specialist's latest unpersisted reply — the mockup, before approval. */
  latestReply: ChatMessage | null;
  /** The project workflow's own verdict — the only gate on the Approve button. */
  canApprove: boolean;
}) {
  // The design history is just this project's `design_artifact` nodes —
  // already on `detail`, so no route of its own is needed to read it. Under
  // the mail-chat contract nothing writes one of these until approval, so
  // the specialist's latest reply stands in as a not-yet-persisted design
  // while none exists yet.
  const persisted = useMemo(
    () => detail.nodes.filter((node) => node.kind === "design_artifact").sort((left, right) => left.version - right.version),
    [detail.nodes],
  );
  const draftNode: ArtifactNode | null = latestReply
    ? {
        id: `reply:${latestReply.id}`,
        kind: "design_artifact",
        variant: null,
        stage: 4,
        title: stageName(4),
        version: (persisted.at(-1)?.version ?? 0) + 1,
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
        approval={{
          soloApproval: detail.soloApproval,
          canApprove,
          onApprove: () => onApprove(),
        }}
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
function ProductRequirements({
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

function PanelReviews({ reviews, tenantId }: { reviews: ArtifactNode[]; tenantId: string }) {
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

