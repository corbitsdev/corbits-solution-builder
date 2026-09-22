/**
 * The stage's gate: opening a review, approving it, sending the stage back,
 * and stage 9's delivery accept. Every path names the reviewable material by
 * exact `{artifactId, version, sha256}` — the browser's one legitimate job
 * is to find or persist the material; the workflow decides whether a review
 * is open and whether an approve lands (`allowed.approve` is the ONE gate
 * on the Approve control, CL-8687).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure, type ProjectDetail, type Remediation } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import {
  approveStage,
  digestOf,
  ensureReviewOpen,
  reviewableArtifact,
  sendBack as sendBackDecision,
  type StageApprovalDeps,
} from "../../stage-approval.ts";
import { buildEvidenceState, currentPublishedBundle } from "./build.jsx";
import { approvedStage8Archive, composeStage9Opening, manifestCompanionOf } from "./stage9-opening.ts";
import { frozenSummaryLine, stageEvidence, stageRefusalMessage } from "../../stage-evidence.ts";
import type { Stage7Evidence } from "@solutions-builder/app/project-workflow/contracts";
import { targetOpeningLine } from "./freeze.jsx";
import type { ProjectWorkflowView } from "../../project-workflow.ts";

const LAST_STAGE = 9;

const stageApprovalDeps: StageApprovalDeps = {
  view: (projectId: string) => api.projectWorkflowView(projectId),
  decide: (projectId: string, decision: Record<string, unknown>) => api.decide(projectId, decision),
  now: () => new Date().toISOString(),
};

export type StageDecisions = {
  /** The Approve control's ONE gate — the workflow's own verdict, never
   *  re-derived from chat or artifact presence. */
  readonly approveAllowed: boolean;
  readonly approving: boolean;
  /** The current attempt's `publish_workspace` fallback bundle, when some
   *  reply since the last "Start"/"Continue" mail carries one (CL-8739) —
   *  not only the latest reply, so a specialist that ran the tool then kept
   *  talking doesn't lose the bundle a prior reply already carried. */
  readonly publishedBundle: ReturnType<typeof currentPublishedBundle>;
  /** Stage 8's own readiness rule (CL-8723): a review may only open once the
   *  current attempt has published an archive or carries the fallback
   *  bundle — a status update is conversation, not a build archive. */
  readonly stage8Evidence: ReturnType<typeof buildEvidenceState> | null;
  /** Persists (if needed) and opens the review for the current material,
   *  right now — `BuildPanel`'s "Accept as evidence" calls it directly. */
  readonly openReviewNow: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly approve: () => Promise<void>;
  /** Stage 9's Accept: the tool approval is resolved in the delivery panel;
   *  this sends the workflow's own stage-9 `approve` — without it `done`
   *  never fires and the project never finishes. */
  readonly acceptDelivery: () => Promise<void>;
  readonly chosenTarget: string | null;
  readonly setChosenTarget: (target: string | null) => void;
  readonly sendTarget: number | null;
  readonly setSendTarget: (target: number | null) => void;
  readonly sendReason: string;
  readonly setSendReason: (reason: string) => void;
  readonly sendingBack: boolean;
  /** Sends this stage back to `target` through the workflow's `send_back`
   *  decision — every review at `target` and above is marked stale, nothing
   *  is deleted. */
  readonly sendBack: (target: number) => Promise<void>;
};

export function useStageDecisions({
  detail,
  tenantId,
  stage,
  workflowView,
  reviewMessage,
  draftKind,
  foldedMessages,
  refreshWorkflow,
  markStage,
  queueOpening,
  onError,
  onRemediation,
}: {
  detail: ProjectDetail;
  tenantId: string;
  stage: number;
  workflowView: ProjectWorkflowView | null;
  reviewMessage: ChatMessage | null;
  draftKind: string | null;
  foldedMessages: ChatMessage[];
  refreshWorkflow: () => Promise<void>;
  markStage: (stage: number) => void;
  queueOpening: (stage: number, body: string) => void;
  onError: (message: string | null) => void;
  onRemediation: (remediation: Remediation | undefined) => void;
}): StageDecisions {
  const [approving, setApproving] = useState(false);
  const [chosenTarget, setChosenTargetState] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<number | null>(null);
  const [sendReason, setSendReason] = useState("");
  const [sendingBack, setSendingBack] = useState(false);

  // Stage 7's chosen target resets whenever the stage changes so an earlier
  // project's choice never leaks into a new one.
  useEffect(() => {
    setChosenTargetState(null);
  }, [stage]);

  const publishedBundle = useMemo(
    () => (stage === 8 ? currentPublishedBundle(foldedMessages) : null),
    [stage, foldedMessages],
  );
  const stage8Evidence = useMemo(
    () => (stage === 8 ? buildEvidenceState(foldedMessages, detail.nodes, publishedBundle !== null) : null),
    [stage, foldedMessages, detail.nodes, publishedBundle],
  );

  /**
   * The reviewable version as `{artifactId, version, sha256}`: finds or
   * persists the material, never judges whether it is "ready". Stage 8
   * (CL-8723) reads the archive `publish_workspace` already uploaded — no
   * browser write. Every other stage persists the specialist's reply as the
   * draft when nothing else wrote one. Stage 7's chosen target rides along
   * in the same artifact write (`sb.target`) so `approve()`'s opening mail
   * can quote it without re-deriving it from the plan.
   */
  const resolveReviewRef = useCallback(async (): Promise<{ artifactId: string; version: number; sha256: string } | null> => {
    if (!reviewMessage || draftKind === null) return null;
    if (stage === 8 && !stage8Evidence?.ready) return null;
    const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
    const latestDraft = stage === 8 ? publishedBundle : reviewMessage;
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft });
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
  }, [reviewMessage, draftKind, detail.nodes, detail.project.id, stage, publishedBundle, chosenTarget, stage8Evidence]);

  const openReviewNow = useCallback(async () => {
    if (!workflowView || workflowView.done || stage >= LAST_STAGE) return { ok: false as const, reason: "There is nothing to review yet." };
    if (stage === 7 && !chosenTarget) return { ok: false as const, reason: "No delivery target has been chosen yet." };
    if (!reviewMessage || draftKind === null) return { ok: false as const, reason: "There is nothing to review yet." };
    if (stage === 8 && !stage8Evidence?.ready) {
      return { ok: false as const, reason: stage8Evidence?.reason ?? "The build has not published an archive yet." };
    }
    const latestDraft = stage === 8 ? publishedBundle : reviewMessage;
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft });
    if (reviewable.status === "none") return { ok: false as const, reason: "There is nothing to review yet." };
    try {
      const ref = await resolveReviewRef();
      if (!ref) return { ok: false as const, reason: "There is nothing to review yet." };
      const sameAsOpen =
        workflowView.openReview !== null &&
        workflowView.openReview.artifactId === ref.artifactId &&
        workflowView.openReview.version === ref.version &&
        workflowView.openReview.sha256 === ref.sha256;
      if (!sameAsOpen) {
        await ensureReviewOpen(stageApprovalDeps, { projectId: detail.project.id, stage, ref });
      }
      await refreshWorkflow();
      return { ok: true as const };
    } catch (cause) {
      return { ok: false as const, reason: cause instanceof ApiFailure ? cause.detail.message : String(cause) };
    }
  }, [workflowView, stage, chosenTarget, reviewMessage, draftKind, stage8Evidence, publishedBundle, detail.nodes, detail.project.id, resolveReviewRef, refreshWorkflow]);

  // Opens the review the moment this stage's material is ready rather than
  // at the instant of approval — a review that only opens inside `approve()`
  // would leave `allowed.approve` false right up until then, making it
  // useless as a button gate (CL-8687 follow-up). Skips stage 7 until a
  // target is chosen, and keys on the resolved material's id/version so a
  // fresh draft opens its own review. Idempotent under reload/two tabs:
  // `ensureReviewOpen` itself no-ops once the view shows the same ref open.
  const ensuringReviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workflowView || workflowView.done || stage >= LAST_STAGE) return;
    if (stage === 7 && !chosenTarget) return;
    if (!reviewMessage || draftKind === null) return;
    if (stage === 8 && !stage8Evidence?.ready) return;
    const latestDraft = stage === 8 ? publishedBundle : reviewMessage;
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft });
    if (reviewable.status === "none") return;
    const key =
      reviewable.status === "found"
        ? `${String(stage)}:${reviewable.node.artifactId}@${String(reviewable.node.version)}`
        : `${String(stage)}:draft:${reviewMessage.id}`;
    if (ensuringReviewKeyRef.current === key) return;
    ensuringReviewKeyRef.current = key;
    void openReviewNow().then((result) => {
      // Left as the sentinel on refusal: a later render (a poll, a reply) retries.
      if (!result.ok) ensuringReviewKeyRef.current = null;
    });
  }, [workflowView, stage, chosenTarget, reviewMessage, draftKind, detail.nodes, publishedBundle, stage8Evidence, openReviewNow]);

  /**
   * Sends the workflow's `approve` decision for this stage's already-open
   * review (`approveStage` opens one itself, belt-and-braces, if somehow
   * none is) and waits for it to land before treating the stage as advanced
   * — the workflow is the process authority. On a refusal the error shows
   * the reason and the next stage's opening mail is never sent.
   */
  const approve = async () => {
    if (!reviewMessage || stage >= LAST_STAGE) return;
    if (stage === 7 && !chosenTarget) return;
    setApproving(true);
    onError(null);
    onRemediation(undefined);
    try {
      // The normal path reads the ref straight off the already-open review —
      // resolving it again would persist a second, redundant draft version
      // every approval. `resolveReviewRef` is the fallback for the rare case
      // nothing is open yet.
      const ref = workflowView?.openReview
        ? {
            artifactId: workflowView.openReview.artifactId,
            version: workflowView.openReview.version,
            sha256: workflowView.openReview.sha256,
          }
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
        onError(`This stage's approval was refused: ${stageRefusalMessage(result.reason)}`);
        await refreshWorkflow();
        return;
      }
      markStage(result.stage);
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
      queueOpening(result.stage, openingBody);
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      onRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setApproving(false);
    }
  };

  /**
   * The reference is the `delivery_manifest` companion of stage 8's approved
   * review — the workflow's own record of what stage 9 reviewed — falling
   * back to the archive itself if no manifest companion exists.
   */
  const acceptDelivery = async () => {
    setApproving(true);
    onError(null);
    try {
      const archiveNode = approvedStage8Archive(detail.nodes, workflowView?.reviews[8]);
      const evidenceNode = archiveNode ? (manifestCompanionOf(detail.nodes, archiveNode) ?? archiveNode) : null;
      if (!evidenceNode) {
        onError("No build evidence is recorded for this project yet — delivery cannot be finished.");
        return;
      }
      const ref = {
        artifactId: evidenceNode.artifactId,
        version: evidenceNode.version,
        sha256: evidenceNode.contentSha256 ?? (await digestOf(evidenceNode.id)),
      };
      const result = await approveStage(stageApprovalDeps, { projectId: detail.project.id, stage: 9, ref });
      if (!result.ok) {
        onError(`Delivery was recorded, but the project workflow refused the final approval: ${stageRefusalMessage(result.reason)}`);
        await refreshWorkflow();
        return;
      }
      await refreshWorkflow();
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setApproving(false);
    }
  };

  const sendBack = async (target: number) => {
    setSendingBack(true);
    onError(null);
    try {
      const result = await sendBackDecision(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        targetStage: target,
        reason: sendReason.trim() || `Sent back from stage ${stage} to stage ${target}.`,
      });
      if (!result.ok) {
        onError(`Send-back was refused: ${result.reason}`);
        return;
      }
      markStage(result.stage);
      await refreshWorkflow();
      setSendReason("");
      setSendTarget(null);
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setSendingBack(false);
    }
  };

  return {
    approveAllowed: workflowView?.allowed.approve ?? false,
    approving,
    publishedBundle,
    stage8Evidence,
    openReviewNow,
    approve,
    acceptDelivery,
    chosenTarget,
    setChosenTarget: setChosenTargetState,
    sendTarget,
    setSendTarget,
    sendReason,
    setSendReason,
    sendingBack,
    sendBack,
  };
}
