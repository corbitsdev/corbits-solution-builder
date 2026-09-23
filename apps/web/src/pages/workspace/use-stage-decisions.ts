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
  mintRequirements as mintRequirementsDecision,
  reviewableArtifact,
  sendBack as sendBackDecision,
  type StageApprovalDeps,
} from "../../stage-approval.ts";
import { extractRequirementItems } from "@solutions-builder/app/requirements";
import { buildEvidenceState, currentPublishedBundle } from "./build.jsx";
import { approvedStage8Archive, composeStage9Opening, manifestCompanionOf } from "./stage9-opening.ts";
import { frozenSummaryLine, stageEvidence, stageRefusalMessage } from "../../stage-evidence.ts";
import type { Stage7Evidence } from "@solutions-builder/app/project-workflow/contracts";
import { targetOpeningLine } from "./freeze.jsx";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { clearQuotedDraft } from "./quote-store.js";

const LAST_STAGE = 9;

/** Whether a freshly-read stakeholder policy is the one the workflow's own
 *  view already has captured -- order-sensitive, since a reordered list is
 *  still a changed policy worth recapturing on the next `open_review`. */
function audiencePolicyEquals(
  next: { quorum: number; stakeholders: readonly string[] },
  current: { quorum: number; stakeholders: readonly string[] } | null,
): boolean {
  if (!current) return false;
  if (next.quorum !== current.quorum) return false;
  if (next.stakeholders.length !== current.stakeholders.length) return false;
  return next.stakeholders.every((name, index) => name === current.stakeholders[index]);
}

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
  /** Mints `ProjectState.requirements` from the requirements-author's
   *  accepted PRODUCT_REQUIREMENTS document, once, before the Architect
   *  drafts (CL-8862) — `Stage6Panel` calls this the moment that document's
   *  reply lands. Idempotent: a project whose requirements are already
   *  minted (this call, another tab, a retry) resolves without surfacing an
   *  error. */
  readonly mintRequirements: (markdown: string) => Promise<void>;
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
  // Stage 5's reviewable material is a stakeholder package
  // (`persistAudiencePackage`, stamped with `provenance.agentRole` the same
  // as every other stage's written artifact) -- the stage's own chat reply
  // is never a fallback draft here, so a stage-5 approve/open-review can
  // never persist that reply as a nameless package (CL-8892).
  const latestDraftFor = useCallback(
    (): unknown => (stage === 8 ? publishedBundle : stage === 5 ? null : reviewMessage),
    [stage, publishedBundle, reviewMessage],
  );

  const resolveReviewRef = useCallback(async (): Promise<{ artifactId: string; version: number; sha256: string } | null> => {
    if (!reviewMessage || draftKind === null) return null;
    if (stage === 8 && !stage8Evidence?.ready) return null;
    const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
    const latestDraft = latestDraftFor();
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
  }, [reviewMessage, draftKind, detail.nodes, detail.project.id, stage, chosenTarget, stage8Evidence, latestDraftFor]);

  // Stage 5's quorum policy, read fresh off the project's policy right
  // before it is captured onto an `open_review` decision (CL-8870) -- never
  // cached, so the policy captured is whatever is in effect at that moment.
  const stage5Policy = useCallback(async () => {
    if (stage !== 5) return undefined;
    const policy = await api.stakeholders(detail.project.id);
    return { quorum: policy.audienceQuorum, stakeholders: policy.audiences.map((audience) => audience.name) };
  }, [stage, detail.project.id]);

  const openReviewNow = useCallback(async () => {
    if (!workflowView || workflowView.done || stage >= LAST_STAGE) return { ok: false as const, reason: "There is nothing to review yet." };
    if (stage === 7 && !chosenTarget) return { ok: false as const, reason: "No delivery target has been chosen yet." };
    if (!reviewMessage || draftKind === null) return { ok: false as const, reason: "There is nothing to review yet." };
    if (stage === 8 && !stage8Evidence?.ready) {
      return { ok: false as const, reason: stage8Evidence?.reason ?? "The build has not published an archive yet." };
    }
    // Stage 5's policy is read fresh, before anything else -- a review must
    // never auto-open on whatever default policy happened to exist when the
    // first reply landed (CL-8891); it waits until stakeholders are named
    // with a quorum they can actually reach.
    const policy = await stage5Policy();
    if (stage === 5 && (!policy || policy.quorum > policy.stakeholders.length)) {
      return { ok: false as const, reason: "Stakeholders need to be named, with a reachable quorum, before a review can open." };
    }
    const latestDraft = latestDraftFor();
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
      // Editing the stakeholder list/quorum while a review is already open
      // on the same material must still recapture the policy -- otherwise
      // the review stays checked against whatever policy existed when it
      // first opened (CL-8891).
      const policyChanged = stage === 5 && policy && !audiencePolicyEquals(policy, workflowView.audiencePolicy);
      if (!sameAsOpen || policyChanged) {
        await ensureReviewOpen(stageApprovalDeps, { projectId: detail.project.id, stage, ref, ...(policy ? { policy } : {}) });
      }
      await refreshWorkflow();
      return { ok: true as const };
    } catch (cause) {
      return { ok: false as const, reason: cause instanceof ApiFailure ? cause.detail.message : String(cause) };
    }
  }, [workflowView, stage, chosenTarget, reviewMessage, draftKind, stage8Evidence, detail.nodes, detail.project.id, resolveReviewRef, refreshWorkflow, stage5Policy, latestDraftFor]);

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
    const latestDraft = latestDraftFor();
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
  }, [workflowView, stage, chosenTarget, reviewMessage, draftKind, detail.nodes, latestDraftFor, stage8Evidence, openReviewNow]);

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
        artifactContent: (tid, nodeId) => api.artifactContent(tid, nodeId),
      });
      const policy = await stage5Policy();
      const result = await approveStage(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        ref,
        evidence,
        ...(policy ? { policy } : {}),
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
      // The passages that led the reason are spent with it.
      clearQuotedDraft(tenantId, stage);
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setSendingBack(false);
    }
  };

  const mintRequirements = useCallback(
    async (markdown: string) => {
      if (stage !== 6) return;
      const items = extractRequirementItems(markdown);
      if (items.length === 0) return;
      const result = await mintRequirementsDecision(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        items,
      });
      if (!result.ok) {
        onError(`Minting the requirement ids was refused: ${stageRefusalMessage(result.reason)}`);
        return;
      }
      await refreshWorkflow();
    },
    [stage, detail.project.id, onError, refreshWorkflow],
  );

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
    mintRequirements,
  };
}
