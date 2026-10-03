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
import { designHandoff } from "../../design-handoff.ts";
import { useEffect, useRef, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
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
import { renderRequirementsBlock } from "@solutions-builder/app/requirements";
import { sendBackResumeCue } from "./send-back-cue.ts";
import { handoffPending } from "./use-model-handoff.ts";
import { approvedChainQuery, composeApprovedChain } from "./approved-chain.ts";
import { importedHistory } from "./imported-history.ts";
import { queryClient } from "../../queries/client.ts";
import { keys } from "../../queries/keys.ts";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { precedingStage } from "@solutions-builder/app/project-workflow/contracts";

export type OpeningDispatch = {
  /** The opening send failed — surfaced with a retry, never retried forever. */
  readonly error: string | null;
  readonly retry: () => void;
  /** `approve()` hands the just-approved draft to the next stage's thread. */
  readonly queueOpening: (stage: number, body: string) => void;
  /** Stage 6's own opening material -- the approved record and stage 5's
   *  approved review, the same content the Architect's opening carries --
   *  fetched independently of whether requirements have been minted yet.
   *  `Stage6Panel` asks the
   *  requirements author from this, never from the person's last chat
   *  message (empty on a fresh stage 6, on reload and in session alike, so
   *  minting could never start without the person typing first). Null off
   *  stage 6, or before stage 5's review is readable. */
  readonly stage6Material: string | null;
};

export function useOpeningDispatch({
  detail,
  tenantId,
  stage,
  agentAddress,
  addresses,
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
  /** Every address this stage's mail has lived at (`useStageAgent.addresses`):
   *  the live one among others means a redeploy, and a hand-off owed. */
  addresses: readonly string[];
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
  // review IS the input to this one (CL-8687), a stage the project's surface
  // skipped passed over. No approved review there means there is no input yet.
  const previousApproved = (() => {
    if (stage <= 1 || !workflowView) return null;
    const review = workflowView.reviews[precedingStage(stage, workflowView.skipped)];
    if (!review || review.status !== "approved") return null;
    return { artifactId: review.artifactId, version: review.version };
  })();

  const stage5Approved = stage === 6 ? previousApproved : null;
  const stage6Chain = useQuery({ ...approvedChainQuery({ tenantId, nodes: detail.nodes, reviews: workflowView?.reviews ?? {}, stage, skipped: workflowView?.skipped ?? [] }), enabled: stage5Approved !== null });
  const stage5VersionId = stage5Approved ? versionIdFor(stage5Approved.artifactId, stage5Approved.version) : null;
  const stage5Package = useQuery({
    queryKey: keys.artifact.of(tenantId, stage5VersionId ?? ""),
    queryFn: stage5VersionId ? () => api.artifactContent(tenantId, stage5VersionId) : skipToken,
  });
  // Nothing until the whole record is read: a partial input would ask the
  // requirements author once without the record and again with it.
  const stage6Material =
    stage5Approved && stage6Chain.isSuccess && stage5Package.data?.content
      ? stage6Chain.data
        ? `${stage6Chain.data}\n\n${stage5Package.data.content}`
        : stage5Package.data.content
      : null;

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
    const dispatchOpening = (opening: string) => {
      if (cancelled || openedRef.current === key || inFlightRef.current === key) return;
      inFlightRef.current = key;
      void markerAlreadySent(createHubTransport(), tenantId, marker)
        .then(async (already) => {
          if (cancelled) return;
          if (already) {
            openedRef.current = key;
            await reloadThread();
            return;
          }
          // Every approved artifact before this stage, and the person's
          // material, go ahead of the stage's own lead (#423): the
          // specialist reads the record, not only the last document.
          // An imported stage's history rides in the architect's chain alone;
          // the requirements author reads the chain without it.
          const history = await importedHistory(tenantId, detail.nodes, stage);
          const chainDeps = { tenantId, nodes: detail.nodes, reviews: workflowView?.reviews ?? {}, stage, skipped: workflowView?.skipped ?? [] };
          const chain = history
            ? await composeApprovedChain({ ...chainDeps, history })
            : await queryClient.fetchQuery(approvedChainQuery(chainDeps));
          // The workspace's language is in the specialist's own instructions
          // (`localizedRole`, client.ts), where a changed setting redeploys
          // it; the mail carries the record and the stage's lead, nothing else.
          const body = chain ? `${chain}\n\n${opening}` : opening;
          await api.sendStageMail(tenantId, agentAddress, { body, subject: `${marker} ${stageName(stage)}` });
          if (cancelled) return;
          // Marked as opened only now that the send is confirmed —
          // a throw above skips this, so a failed send is retried
          // rather than silently treated as sent.
          openedRef.current = key;
          setError(null);
          await reloadThread();
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
    } else if (stage === 6 && (!workflowView || workflowView.requirements.length === 0)) {
      // The Architect must not draft before `mint_requirements` has run for
      // this project (CL-8862) — `Stage6Panel` mints them off the
      // requirements-author's accepted document; this effect re-fires once
      // `workflowView.requirements` lands, since that view object changes.
      // Ahead of `pendingOpening` in this chain on purpose: the in-session
      // hand-off from `approve()` must wait on the same gate the reload path
      // does, or the Architect's opening goes out before the ids exist to
      // put in it.
    } else if (pendingOpening?.stage === stage) {
      const body =
        stage === 6 && workflowView
          ? `${renderRequirementsBlock(workflowView.requirements)}\n\n${pendingOpening.body}`
          : pendingOpening.body;
      dispatchOpening(body);
    } else if (stage === 9) {
      const review = workflowView?.reviews[8];
      const archiveRef = review?.status === "approved" ? { artifactId: review.artifactId, version: review.version } : null;
      void composeStage9Opening({ tenantId, projectId: detail.project.id, nodes: detail.nodes, archiveRef }).then(dispatchOpening);
    } else if (previousApproved) {
      void api
        .artifactContent(tenantId, versionIdFor(previousApproved.artifactId, previousApproved.version))
        .then((result) => {
          if (!result.content) return;
          // Stage 8's opening also names the frozen target — lost on reload
          // since `pendingOpening` never survives one (defect 4). Rebuilt from
          // the workflow view's own `freeze`, set the moment stage 7 is
          // approved and cleared only by a send-back to stage <= 7.
          const stackBlock = stage === 8 && workflowView?.freeze ? renderStackBlock(workflowView.freeze) : null;
          // Stage 6's opening leads with the workflow-minted requirement ids
          // (CL-8862) — the Architect may cite only these, never invent one.
          const requirementsBlock = stage === 6 && workflowView ? renderRequirementsBlock(workflowView.requirements) : null;
          // Stage 5 opens on the stage 4 design, usually an HTML mockup:
          // handed over as its text, not its markup (#219). With GUI design
          // skipped it opens on the proposal, which passes through as is.
          const approved = stage === 5 ? designHandoff(result.content) : result.content;
          const body =
            stage === 8 && workflowView?.freeze
              ? `${targetOpeningLine(workflowView.freeze.target)}\n\n${frozenSummaryLine({
                  target: workflowView.freeze.target,
                  frozen: workflowView.freeze.frozen,
                })}${stackBlock ? `\n\n${stackBlock}` : ""}\n\n${approved}`
              : requirementsBlock
                ? `${requirementsBlock}\n\n${approved}`
                : approved;
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

  // A send-back lands on a thread that already has history, so the
  // opening-send effect above (gated on an EMPTY thread) never fires — the
  // specialist sees nothing telling it the stage came back, or why, and the
  // person is left facing the draft that was just sent back. One resume cue
  // carrying the send-back's reason goes instead, keyed on the workflow's
  // own decision id so a reload never repeats it (`send-back-cue.ts` holds
  // the rule, including stage 6's wait for the re-minted requirement ids).
  const cueInFlightRef = useRef<string | null>(null);
  useEffect(() => {
    if (!agentAddress) return;
    if (loadedFor !== agentAddress || messages.length === 0) return;
    // A freshly redeployed specialist is owed the hand-off first: the cue
    // says the stage came back, the hand-off says what the stage is. Sent
    // ahead of it, the cue was the mail that made the hand-off stand down,
    // and the specialist answered from the cue alone (#105). The hand-off's
    // own reload of the thread re-runs this once it has landed.
    if (handoffPending({ address: agentAddress, addresses, threadLoaded: loadedFor === agentAddress, messages })) return;
    const cue = sendBackResumeCue({
      stage,
      decisions: workflowView?.decisions ?? [],
      messages,
      requirements: workflowView?.requirements ?? [],
    });
    if (!cue || cueInFlightRef.current === cue.marker) return;
    cueInFlightRef.current = cue.marker;
    void api
      .sendStageMail(tenantId, agentAddress, { body: cue.body })
      .then(() => reloadThread())
      .catch(() => {
        // Not marked as sent: the next thread or view change retries.
        cueInFlightRef.current = null;
      });
  }, [stage, agentAddress, addresses, loadedFor, messages, workflowView, tenantId, reloadThread]);

  return {
    error,
    retry: () => setRetryAttempt((attempt) => attempt + 1),
    queueOpening: (nextStage, body) => setPendingOpening({ stage: nextStage, body }),
    stage6Material,
  };
}
