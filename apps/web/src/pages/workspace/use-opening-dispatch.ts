/**
 * The stage's opening message — the first mail of a fresh thread, sent once.
 *
 * Stage 1's is the problem statement read straight off its lifecycle
 * deployment (`api.projectOpening`, scoped to the workspace tenant
 * `createProject` actually deployed it into — `loadProjectView`'s own fold
 * reads the project's own child tenant, where that deployment never lived,
 * and so always comes back null). A later stage's opening is the previous
 * stage's just-approved draft, either handed over in memory by `approve()`
 * (`queueOpening`) or, across a reload, rebuilt from the workflow's own
 * record — the approved review at N-1 names the exact `artifactId`/`version`,
 * never re-derived by scanning nodes for a kind (CL-8687).
 *
 * Stage 8's opening also names the frozen target (lost on reload, since the
 * in-memory handoff never survives one — rebuilt from the workflow view's
 * `freeze`). Stage 9's is always composed from the delivery manifest and
 * stage 8's own status reply, never the raw stage-8 artifact (it may be the
 * binary archive itself).
 */
import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiFailure,
  createHubTransport,
  type ProjectDetail,
} from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { markerAlreadySent } from "../../decision-notify.ts";
import { stageName } from "../../components.jsx";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { frozenSummaryLine } from "../../stage-evidence.ts";
import { targetOpeningLine } from "./freeze.jsx";
import { composeStage9Opening } from "./stage9-opening.ts";
import { renderStackBlock } from "./frozen-stack-text.ts";

export type OpeningDispatch = {
  /** The opening send failed — surfaced with a retry, never retried forever. */
  readonly error: string | null;
  readonly retry: () => void;
  /** `approve()` hands the just-approved draft to the next stage's thread. */
  readonly queueOpening: (stage: number, body: string) => void;
};

export function useOpeningDispatch({
  detail,
  tenantId,
  stage,
  agentAddress,
  messages,
  loadedFor,
  workflowView,
  reloadThread,
}: {
  detail: ProjectDetail;
  tenantId: string;
  stage: number;
  /** Already scoped to the current stage by `useStageAgent` — a null or
   *  stale address never reaches here (CL-8649). */
  agentAddress: string | null;
  messages: ChatMessage[];
  loadedFor: string | null;
  workflowView: ProjectWorkflowView | null;
  reloadThread: () => Promise<void>;
}): OpeningDispatch {
  // Set only once the send is confirmed (either this tab's own send landed,
  // or another tab's already had, per the marker check below) — never
  // beforehand, so a send that throws is retried rather than treated as done.
  const openedRef = useRef<string | null>(null);
  // Guards a single key against a second concurrent attempt from this same
  // component — a narrower, synchronous version of what the marker already
  // guards across tabs and reloads.
  const inFlightRef = useRef<string | null>(null);
  // A key already auto-retried once, so a second failure surfaces instead of
  // retrying forever.
  const autoRetriedRef = useRef<string | null>(null);
  const [pendingOpening, setPendingOpening] = useState<{ stage: number; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);

  // Stage 1's own opening problem statement.
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

  // The previous project's opening state must never leak into a newly opened
  // one even if the keyed remount ever regresses.
  useEffect(() => {
    setPendingOpening(null);
    setError(null);
    openedRef.current = null;
    inFlightRef.current = null;
    autoRetriedRef.current = null;
  }, [detail.project.id]);

  // Fallback source for a stage > 1 opening when `pendingOpening` was never
  // set in this mounted component — a reload, a re-opened project, or the
  // stage cursor advancing some other way. The previous stage's approved
  // review IS the input to this one (CL-8687). No approved review at N-1
  // means there is no input yet.
  const previousApproved = (() => {
    if (stage <= 1 || !workflowView) return null;
    const review = workflowView.reviews[stage - 1];
    if (!review || review.status !== "approved") return null;
    return { artifactId: review.artifactId, version: review.version };
  })();

  useEffect(() => {
    if (!agentAddress) return;
    // Wait for the thread read to land for this exact address before judging
    // it empty — otherwise a fresh run's still-stale `messages` from the
    // previous address could either wrongly suppress or wrongly trigger the
    // opening send (CL-8656).
    if (loadedFor !== agentAddress || messages.length > 0) return;
    const key = `${detail.project.id}:${stage}:${agentAddress}`;
    if (openedRef.current === key || inFlightRef.current === key) return;

    let cancelled = false;
    // Server-visible dedup (defect: duplicate opening mail across two tabs)
    // — the same `[marker]`-in-Sent-folder check `decision-notify.ts` uses,
    // keyed to this project's stage rather than a decision id, so two tabs
    // that both load an empty stage N+1 thread never both send its opening.
    const marker = `[opening:${detail.project.id}:${stage}]`;
    const dispatchOpening = (body: string) => {
      if (cancelled || openedRef.current === key || inFlightRef.current === key) return;
      inFlightRef.current = key;
      void markerAlreadySent(createHubTransport(), tenantId, marker)
        .then((already) => {
          if (cancelled) return undefined;
          if (already) {
            openedRef.current = key;
            return reloadThread();
          }
          return api
            .sendStageMail(tenantId, agentAddress, { body, subject: `${marker} ${stageName(stage)}` })
            .then(() => {
              if (cancelled) return undefined;
              // Marked as opened only now that the send is confirmed —
              // a throw above skips this, so a failed send is retried
              // rather than silently treated as sent.
              openedRef.current = key;
              setError(null);
              return reloadThread();
            });
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
          if (autoRetriedRef.current !== key) {
            autoRetriedRef.current = key;
            setTimeout(() => {
              if (!cancelled) setRetryAttempt((attempt) => attempt + 1);
            }, 3_000);
          }
        })
        .finally(() => {
          if (inFlightRef.current === key) inFlightRef.current = null;
        });
    };

    if (stage === 1) {
      if (opening?.body) dispatchOpening(opening.body);
    } else if (pendingOpening?.stage === stage) {
      dispatchOpening(pendingOpening.body);
    } else if (stage === 9) {
      const review = workflowView?.reviews[8];
      const archiveRef = review?.status === "approved" ? { artifactId: review.artifactId, version: review.version } : null;
      void composeStage9Opening({ tenantId, projectId: detail.project.id, nodes: detail.nodes, archiveRef }).then(dispatchOpening);
    } else if (previousApproved) {
      void api
        .artifactContent(tenantId, previousApproved.artifactId)
        .then((result) => {
          if (!result.content) return;
          // Stage 8's opening also names the frozen target — lost on reload
          // since `pendingOpening` never survives one (defect 4). Rebuilt from
          // the workflow view's own `freeze`, set the moment stage 7 is
          // approved and cleared only by a send-back to stage <= 7.
          const stackBlock = stage === 8 && workflowView?.freeze ? renderStackBlock(workflowView.freeze) : null;
          const body =
            stage === 8 && workflowView?.freeze
              ? `${targetOpeningLine(workflowView.freeze.target)}\n\n${frozenSummaryLine({
                  target: workflowView.freeze.target,
                  frozen: workflowView.freeze.frozen,
                })}${stackBlock ? `\n\n${stackBlock}` : ""}\n\n${result.content}`
              : result.content;
          dispatchOpening(body);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [
    agentAddress,
    messages.length,
    loadedFor,
    stage,
    detail.project.id,
    detail.nodes,
    opening,
    pendingOpening,
    previousApproved,
    tenantId,
    reloadThread,
    workflowView,
    retryAttempt,
  ]);

  // A send-back into stage 8 lands on a thread that already has history, so
  // the opening-send effect above (gated on an EMPTY thread) never fires —
  // the build specialist sees nothing telling it the stage came back. Sends
  // one resume cue instead, keyed on the workflow's own send-back decision id
  // (embedded in the message body) so a reload never repeats it.
  useEffect(() => {
    if (stage !== 8 || !agentAddress) return;
    if (loadedFor !== agentAddress || messages.length === 0) return;
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
      .then(() => reloadThread())
      .catch(() => {});
  }, [stage, agentAddress, loadedFor, messages, workflowView, tenantId, reloadThread]);

  return {
    error,
    retry: () => setRetryAttempt((attempt) => attempt + 1),
    queueOpening: (nextStage, body) => setPendingOpening({ stage: nextStage, body }),
  };
}
