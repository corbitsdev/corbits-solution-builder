/**
 * The stage's gate: opening a review, approving it, sending the stage back,
 * and stage 9's delivery accept. Every path names the reviewable material by
 * exact `{artifactId, version, sha256}` — the browser's one legitimate job
 * is to find or persist the material; the workflow decides whether a review
 * is open and whether an approve lands (`allowed.approve` is the ONE gate
 * on the Approve control, CL-8687).
 */
import { stageName } from "../../components.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure, type BuildAttempt, type ProjectDetail, type Remediation } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import {
  approveStage,
  digestOf,
  ensureReviewOpen,
  mintRequirements as mintRequirementsDecision,
  packageRefsOf,
  packagesEqual,
  reviewableArtifact,
  sendBack as sendBackDecision,
  type StageApprovalDeps,
} from "../../stage-approval.ts";
import { packagesByStakeholder } from "../../package-lineages.ts";
import { extractRequirementItems, requirementsDiffer, mintRequirementEntries, renderRequirementsBlock } from "@solutions-builder/app/requirements";
import { buildEvidenceState } from "./build-attempts.ts";
import { approvedStage8Archive, composeStage9Opening, manifestCompanionOf } from "./stage9-opening.ts";
import {
  frozenSummaryLine,
  openReviewFailureMessage,
  stage6RefusalMessage,
  stage6StackProblem,
  stage7StackProblem,
  stageEvidence,
  stageRefusalMessage, stage6StackRemediation } from "../../stage-evidence.ts";
import type { Stage7Evidence } from "@solutions-builder/app/project-workflow/contracts";
import { targetOpeningLine } from "./freeze.jsx";
import { designHandoff } from "../../design-handoff.ts";
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
  /** Stage 8's own readiness rule: a review may only open once the host has
   *  packaged an ended attempt and the archive is recorded, with no worker
   *  running and no later attempt since — a status update is conversation,
   *  not a build archive. */
  readonly stage8Evidence: ReturnType<typeof buildEvidenceState> | null;
  /** Persists (if needed) and opens the review for the current material,
   *  right now — opened automatically once the material is ready.
   *  `failed` marks an open that was tried and did not land (the hub or the
   *  workflow refused it, or threw), as against a precondition not met yet;
   *  the automatic open shows the former in the error banner (#169). */
  readonly openReviewNow: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly failed?: true }>;
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
   *  is deleted. `reason` given here wins over the held `sendReason`: a
   *  caller that composed the reason in the same click cannot wait for
   *  state to settle (#248). */
  readonly sendBack: (target: number, reason?: string) => Promise<void>;
  /** Mints `ProjectState.requirements` from the requirements-author's
   *  accepted PRODUCT_REQUIREMENTS document, once, before the Architect
   *  drafts (CL-8862) — `Stage6Panel` calls this the moment that document's
   *  reply lands. Idempotent: a project whose requirements are already
   *  minted (this call, another tab, a retry) resolves without surfacing an
   *  error. */
  readonly mintRequirements: (markdown: string, recorded?: boolean) => Promise<void>;
};

export function useStageDecisions({
  detail,
  tenantId,
  stage,
  workflowView,
  reviewMessage,
  documentRef = null,
  draftKind,
  foldedMessages,
  refreshWorkflow,
  markStage,
  queueOpening,
  onError,
  onRemediation,
  onDetailChanged,
  onRequirementsReminted,
  buildAttempts = [],
  buildAttemptsLoaded = true,
}: {
  detail: ProjectDetail;
  tenantId: string;
  stage: number;
  workflowView: ProjectWorkflowView | null;
  reviewMessage: ChatMessage | null;
  /** The stage document's exact version when the specialist keeps it in an
   *  artifact: that version is the reviewable material, nothing is persisted. */
  documentRef?: { readonly artifactId: string; readonly version: number; readonly contentSha256: string | null } | null;
  draftKind: string | null;
  foldedMessages: ChatMessage[];
  refreshWorkflow: () => Promise<void>;
  markStage: (stage: number) => void;
  queueOpening: (stage: number, body: string) => void;
  onError: (message: string | null) => void;
  onRemediation: (remediation: Remediation | undefined) => void;
  /** The project's artifact graph changed under the page (#328): re-read it. */
  onDetailChanged?: () => void;
  /** The requirement ids were re-issued from a revised document (#347): the rendered block, for the architect. */
  onRequirementsReminted?: (block: string) => void;
  /** Stage 8: the host's attempts (`useBuildAttempts`), which say whether the recorded archive is current. */
  buildAttempts?: readonly BuildAttempt[];
  /** Whether those attempts have been read yet: the review never opens on an archive before the host has said what is running. */
  buildAttemptsLoaded?: boolean;
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

  const stage8Evidence = useMemo(
    () => (stage === 8 ? buildEvidenceState(detail.nodes, buildAttempts, buildAttemptsLoaded) : null),
    [stage, detail.nodes, buildAttempts, buildAttemptsLoaded],
  );

  /**
   * The reviewable version as `{artifactId, version, sha256}`: finds or
   * persists the material, never judges whether it is "ready". Stage 8
   * reads the archive the build panel already recorded from the host's
   * packaging — never the supervisor's reply. Every other stage persists the specialist's reply as the
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
    (): unknown => (stage === 8 || stage === 5 ? null : reviewMessage),
    [stage, reviewMessage],
  );
  // When the chat reply is the draft, when it was sent: `reviewableArtifact`
  // persists a reply newer than the newest persisted version instead of
  // reviewing that old version again (the send-back case).
  const latestDraftAtFor = useCallback(
    (): string | null => (stage === 8 || stage === 5 ? null : (reviewMessage?.at ?? null)),
    [stage, reviewMessage],
  );

  const resolveReviewRef = useCallback(async (): Promise<{ artifactId: string; version: number; sha256: string } | null> => {
    if (!reviewMessage || draftKind === null) return null;
    if (documentRef) {
      return { artifactId: documentRef.artifactId, version: documentRef.version, sha256: await digestOf(reviewMessage.body, documentRef.contentSha256) };
    }
    if (stage === 8 && !stage8Evidence?.ready) return null;
    const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
    const latestDraft = latestDraftFor();
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft, latestDraftAt: latestDraftAtFor() });
    if (reviewable.status === "found") {
      return {
        artifactId: reviewable.node.artifactId,
        version: reviewable.node.version,
        sha256: reviewable.node.contentSha256 ?? (await digestOf(reviewMessage.body)),
      };
    }
    if (reviewable.status !== "persist_needed") return null;
    const persisted = await api.persistStageDraft(
      detail.project.id,
      stage,
      reviewMessage.body,
      materials,
      stage === 7 ? (chosenTarget ?? undefined) : undefined,
    );
    const version = Number(persisted.contentHash.slice(persisted.contentHash.lastIndexOf("@") + 1));
    const sha256 = await digestOf(reviewMessage.body);
    return { artifactId: persisted.artifactId, version, sha256 };
  }, [reviewMessage, documentRef, draftKind, detail.nodes, detail.project.id, stage, chosenTarget, stage8Evidence, latestDraftFor, latestDraftAtFor]);

  // Stage 5's quorum policy, read fresh off the project's policy right
  // before it is captured onto an `open_review` decision (CL-8870) -- never
  // cached, so the policy captured is whatever is in effect at that moment.
  const stage5Policy = useCallback(async () => {
    if (stage !== 5) return undefined;
    const policy = await api.stakeholders(detail.project.id);
    return { quorum: policy.audienceQuorum, stakeholders: policy.audiences.map((audience) => audience.name) };
  }, [stage, detail.project.id]);

  // Stage 5's packages, one per stakeholder, referenced the way a vote
  // references one (`packageRefOf`) and captured onto the same `open_review`
  // as the policy -- so the reducer can tell a vote on a stakeholder's
  // current package from one on an earlier version of it (#50). Read fresh
  // off the graph each time, like the policy.
  const stage5Packages = useCallback(
    async (policy: { readonly stakeholders: readonly string[] }) => {
      if (stage !== 5) return undefined;
      const nodes = packagesByStakeholder(
        detail.nodes,
        policy.stakeholders.map((name) => ({ name })),
      );
      return packageRefsOf(nodes, (nodeId) => api.artifactContent(tenantId, nodeId).then((result) => result.content));
    },
    [stage, detail.nodes, tenantId],
  );

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
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft, latestDraftAt: latestDraftAtFor() });
    if (!documentRef && reviewable.status === "none") return { ok: false as const, reason: "There is nothing to review yet." };
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
      // And a stakeholder's package written again while the review is open
      // on another's: the review must name the new package for a vote on
      // it to count (#50).
      const packages = policy ? await stage5Packages(policy) : undefined;
      const packagesChanged = packages !== undefined && !packagesEqual(packages, workflowView.audiencePackages);
      if (!sameAsOpen || policyChanged || packagesChanged) {
        const opened = await ensureReviewOpen(stageApprovalDeps, {
          projectId: detail.project.id,
          stage,
          ref,
          ...(policy ? { policy } : {}),
          ...(packages ? { packages } : {}),
        });
        // A refused or unapplied open was reported as success before, and
        // the stage sat with a draft and no approve button (#169).
        if (!opened.ok) {
          const message = openReviewFailureMessage(opened.reason);
          await refreshWorkflow();
          return message === null
            ? { ok: false as const, reason: stageRefusalMessage(opened.reason) }
            : { ok: false as const, reason: message, failed: true as const };
        }
      }
      await refreshWorkflow();
      return { ok: true as const };
    } catch (cause) {
      return { ok: false as const, reason: cause instanceof ApiFailure ? cause.detail.message : String(cause), failed: true as const };
    }
  }, [workflowView, stage, chosenTarget, reviewMessage, documentRef, draftKind, stage8Evidence, detail.nodes, detail.project.id, resolveReviewRef, refreshWorkflow, stage5Policy, stage5Packages, latestDraftFor, latestDraftAtFor]);

  // Opens the review the moment this stage's material is ready rather than
  // at the instant of approval — a review that only opens inside `approve()`
  // would leave `allowed.approve` false right up until then, making it
  // useless as a button gate (CL-8687 follow-up). Skips stage 7 until a
  // target is chosen, and keys on the resolved material's id/version so a
  // fresh draft opens its own review. Idempotent under reload/two tabs:
  // `ensureReviewOpen` itself no-ops once the view shows the same ref open.
  const ensuringReviewKeyRef = useRef<string | null>(null);
  // Whether the banner is showing a failed open of ours, so the next open
  // that lands clears it and nothing else's message is touched.
  const reviewFailureShownRef = useRef(false);
  useEffect(() => {
    if (!workflowView || workflowView.done || stage >= LAST_STAGE) return;
    if (stage === 7 && !chosenTarget) return;
    if (!reviewMessage || draftKind === null) return;
    if (stage === 8 && !stage8Evidence?.ready) return;
    const latestDraft = latestDraftFor();
    const reviewable = reviewableArtifact({ nodes: detail.nodes, stage, kind: draftKind, latestDraft, latestDraftAt: latestDraftAtFor() });
    if (!documentRef && reviewable.status === "none") return;
    // Stage 5 keys on every live package, not only the newest: a rewrite
    // of any stakeholder's package must re-open the review naming it (#50).
    const packagesKey =
      stage === 5
        ? detail.nodes
            .filter((node) => node.kind === "audience_package" && node.supersededByNodeId === null && node.variant)
            .map((node) => node.id)
            .sort()
            .join(",")
        : "";
    const key = documentRef
      ? `${String(stage)}:${documentRef.artifactId}@${String(documentRef.version)}`
      : reviewable.status === "found"
        ? `${String(stage)}:${reviewable.node.artifactId}@${String(reviewable.node.version)}:${packagesKey}`
        : `${String(stage)}:draft:${reviewMessage.id}`;
    if (ensuringReviewKeyRef.current === key) return;
    ensuringReviewKeyRef.current = key;
    void openReviewNow().then((result) => {
      if (result.ok) {
        if (reviewFailureShownRef.current) {
          reviewFailureShownRef.current = false;
          onError(null);
        }
        return;
      }
      // Left as the sentinel on refusal: a later render (a poll, a reply) retries.
      ensuringReviewKeyRef.current = null;
      // A failed open is said, with its reason, rather than retried in
      // silence (#169): the retry still happens, but the person can see
      // why the approve button is missing meanwhile.
      if (result.failed) {
        reviewFailureShownRef.current = true;
        onError(`The review could not be opened: ${result.reason}`);
      }
    });
  }, [workflowView, stage, chosenTarget, reviewMessage, documentRef, draftKind, detail.nodes, latestDraftFor, stage8Evidence, openReviewNow, onError]);

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
    // The workflow's own `stage6Rule` refuses a plan without a usable Stack
    // section (#55); this runs the same check first so the person reads
    // what is wrong in the plan's own terms before the approval is sent.
    if (stage === 6) {
      const requirementIds = new Set((workflowView?.requirements ?? []).map((r) => r.id));
      const problem = stage6StackProblem(reviewMessage.body, requirementIds);
      if (problem) {
        onError(problem);
        // One click asks the architect for the block in full (#325).
        onRemediation(stage6StackRemediation());
        return;
      }
    }
    setApproving(true);
    onError(null);
    onRemediation(undefined);
    try {
      // Stage 7 freezes the approved plan's Stack section. A plan that has
      // none (approved before stage 6 gated on it) or cites badly would be
      // refused by the workflow with nothing to do about it; checked here
      // first, the person reads why and is offered the send-back to stage 6.
      if (stage === 7) {
        const problem = await stage7StackProblem({
          projectId: detail.project.id,
          tenantId,
          nodes: detail.nodes,
          chosenTarget,
          workflowView,
          artifactContent: (tid, nodeId) => api.artifactContent(tid, nodeId),
        });
        if (problem) {
          onError(problem.message);
          onRemediation(problem.remediation);
          return;
        }
      }
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
        planText: reviewMessage.body,
      });
      const policy = await stage5Policy();
      const packages = policy ? await stage5Packages(policy) : undefined;
      const result = await approveStage(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        ref,
        evidence,
        ...(policy ? { policy } : {}),
        ...(packages ? { packages } : {}),
      });
      if (!result.ok) {
        onError(stage === 6 ? stage6RefusalMessage(result.reason) : `This stage's approval was refused: ${stageRefusalMessage(result.reason)}`);
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
            : stage === 4
              ? // The design goes to the presentation creator as its text, not
                // its markup (#219), in session exactly as on reload (#418).
                designHandoff(reviewMessage.body)
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

  const sendBack = async (target: number, reason?: string) => {
    setSendingBack(true);
    onError(null);
    try {
      const said = (reason ?? sendReason).trim();
      const result = await sendBackDecision(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        targetStage: target,
        reason: said || `Sent back from ${stageName(stage)} to ${stageName(target)}.`,
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
    async (markdown: string, recorded = false) => {
      if (stage !== 6) return;
      // The document itself first (#328): recorded in the project's artifact
      // graph, so the strip, the download and a reload all have it. A
      // failure to record is said and does not stop the minting.
      if (!recorded) {
        try {
          await api.persistProductRequirements(detail.project.id, markdown);
          onDetailChanged?.();
        } catch (cause) {
          onError(`The product requirements could not be recorded: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
        }
      }
      const items = extractRequirementItems(markdown);
      if (items.length === 0) return;
      // A revised document re-mints (#347); the same document is a no-op.
      const held = workflowView?.requirements ?? [];
      if (held.length > 0 && !requirementsDiffer(items, held)) return;
      const result = await mintRequirementsDecision(stageApprovalDeps, {
        projectId: detail.project.id,
        stage,
        items,
      });
      if (!result.ok) {
        onError(
          result.reason === "requirements_already_minted"
            ? "The requirements changed, but this project's workflow predates re-minting and kept the earlier ids. Choose Repair this project from the project menu, then reload."
            : `Minting the requirement ids was refused: ${stageRefusalMessage(result.reason)}`,
        );
        return;
      }
      await refreshWorkflow();
      if (held.length > 0) onRequirementsReminted?.(renderRequirementsBlock(mintRequirementEntries(items)));
    },
    [stage, detail.project.id, onError, refreshWorkflow, onDetailChanged, workflowView, onRequirementsReminted],
  );

  return {
    approveAllowed: workflowView?.allowed.approve ?? false,
    approving,
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
