export type StageNumber = number;
export type DecisionKind = "open_review" | "approve" | "send_back";
export type ReviewStatus = "open" | "approved" | "stale";

export interface ReviewState {
  readonly reviewId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
  readonly status: ReviewStatus;
}

export interface DecisionRecord {
  readonly decisionId: string;
  readonly kind: DecisionKind;
  readonly stage: StageNumber;
  readonly accepted: boolean;
  readonly reason?: string;
  readonly principalId: string;
  readonly at?: string;
  readonly targetStage?: StageNumber;
  readonly reviewId?: string;
  readonly artifactId?: string;
  readonly version?: number;
  readonly sha256?: string;
  /** Stage 5 approvals only: the quorum the approve decision was checked
   *  against, so the trail shows why it passed without replaying `evidence`. */
  readonly quorum?: { readonly proceeded: number; readonly required: number; readonly blocked: readonly string[] };
  /** Stage 7 approvals only: the target the freeze was made for. */
  readonly target?: string;
}

/** One stakeholder's own outcome on a stage-5 package, as carried in an
 *  `approve` decision's `evidence.decisions`. */
export interface QuorumDecisionEvidence {
  readonly by: string;
  readonly outcome: "proceed" | "block" | "revise";
  readonly packageArtifactId: string;
  readonly packageVersion: number;
}

/** Stage 5 approve evidence: the quorum policy plus every stakeholder
 *  decision recorded so far (oldest first -- only the latest per stakeholder
 *  counts). */
export interface Stage5Evidence {
  readonly quorum: number;
  readonly stakeholders: readonly string[];
  readonly decisions: readonly QuorumDecisionEvidence[];
}

/** A reference to a stage's approved review, as frozen into stage 7's
 *  `evidence.frozen`. */
export interface FrozenReference {
  readonly stage: StageNumber;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
}

/** Stage 7 approve evidence: the chosen build target plus a frozen reference
 *  to every earlier stage's approved review. */
export interface Stage7Evidence {
  readonly target: string;
  readonly frozen: readonly FrozenReference[];
}

/** The freeze recorded on `ProjectState` once stage 7 is approved: the
 *  chosen target and the frozen references, plus the decision that made
 *  them binding. Cleared by a send-back to stage <= 7. */
export interface Freeze {
  readonly target: string;
  readonly frozen: readonly FrozenReference[];
  readonly decisionId: string;
}

/** `evidence`'s outcome as `quorumState` reports it: pure, no lookups --
 *  the reducer and the UI (`apps/web/src/pages/audiences.tsx`) both import
 *  this from `@solutions-builder/app/project-workflow/contracts` so the
 *  banner text and the refusal agree on what "met" means. */
export interface QuorumState {
  readonly met: boolean;
  readonly proceeded: number;
  readonly required: number;
  readonly blocked: readonly string[];
  readonly missing: readonly string[];
}

/**
 * The carried loop state. `authorizedPrincipals`/`stageOrder`/`reviewCounts`
 * are static-config and bookkeeping the reducer needs on every decision and
 * every advance/send-back; they ride along on the same carry because a loop
 * body's `trigger.payload` is exactly what carry threads forward and there is
 * nowhere else to keep them replay-safe.
 *
 * The workflow never reads an artifact's content. A review names a reference
 * (`artifactId`, `version`, `sha256`) the caller supplies; the reducer only
 * ever compares references against each other, never recomputes a hash.
 */
export interface ProjectState {
  readonly projectId: string;
  readonly stage: StageNumber;
  readonly done: boolean;
  readonly reviews: Readonly<Record<StageNumber, ReviewState | undefined>>;
  readonly decisions: readonly DecisionRecord[];
  readonly authorizedPrincipals: Readonly<Record<StageNumber, readonly string[]>>;
  readonly stageOrder: readonly StageNumber[];
  readonly reviewCounts: Readonly<Record<StageNumber, number>>;
  /** Stage 7's freeze, once approved; cleared by a send-back to stage <= 7. */
  readonly freeze: Freeze | null;
}

interface DecisionCommon {
  readonly decisionId: string;
  readonly projectId: string;
  readonly stage: StageNumber;
  readonly at: string;
}

export interface OpenReviewPayload extends DecisionCommon {
  readonly kind: "open_review";
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
}

export interface ApprovePayload extends DecisionCommon {
  readonly kind: "approve";
  readonly reviewId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
  /** Stage-rule input (`Stage5Evidence`/`Stage7Evidence`), never read by the
   *  reducer's own structural/reference checks -- only by `stageRules`. */
  readonly evidence?: unknown;
}

export interface SendBackPayload extends DecisionCommon {
  readonly kind: "send_back";
  readonly targetStage?: StageNumber;
  readonly reason: string;
}

export type DecisionPayload = OpenReviewPayload | ApprovePayload | SendBackPayload;

export type RefusalCode =
  | "duplicate"
  | "unauthorized"
  | "wrong_project"
  | "wrong_stage"
  | "stale_review"
  | "wrong_artifact"
  | "stale_version"
  | "hash_mismatch"
  | "invalid_target_stage"
  | "already_done"
  | "evidence_missing"
  | "quorum_not_met"
  | "target_missing"
  | "frozen_already";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStageNumber(value: unknown): value is StageNumber {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Structural validation only: types, presence, and the kind-specific shape
 * (`send_back` requires a non-empty `reason`; `targetStage`, when present,
 * must be an integer). Extra/unknown fields (a nested `principalId`, e.g.)
 * are never read and never rejected -- ignoring them is how the top-level
 * stamp stays the only source of principal identity.
 */
export function validateDecisionShape(value: unknown): DecisionPayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.decisionId !== "string" ||
    typeof value.projectId !== "string" ||
    !isStageNumber(value.stage) ||
    typeof value.at !== "string"
  ) {
    return null;
  }
  const common: DecisionCommon = {
    decisionId: value.decisionId,
    projectId: value.projectId,
    stage: value.stage,
    at: value.at,
  };

  if (value.kind === "open_review") {
    if (
      typeof value.artifactId !== "string" ||
      !isStageNumber(value.version) ||
      typeof value.sha256 !== "string"
    ) {
      return null;
    }
    return { ...common, kind: "open_review", artifactId: value.artifactId, version: value.version, sha256: value.sha256 };
  }

  if (value.kind === "approve") {
    if (
      typeof value.reviewId !== "string" ||
      typeof value.artifactId !== "string" ||
      !isStageNumber(value.version) ||
      typeof value.sha256 !== "string"
    ) {
      return null;
    }
    return {
      ...common,
      kind: "approve",
      reviewId: value.reviewId,
      artifactId: value.artifactId,
      version: value.version,
      sha256: value.sha256,
      ...(value.evidence !== undefined ? { evidence: value.evidence } : {}),
    };
  }

  if (value.kind === "send_back") {
    if (typeof value.reason !== "string" || value.reason.length === 0) return null;
    if (value.targetStage !== undefined && !isStageNumber(value.targetStage)) return null;
    return { ...common, kind: "send_back", reason: value.reason, ...(value.targetStage !== undefined ? { targetStage: value.targetStage } : {}) };
  }

  return null;
}

export interface ApplyDecisionInput {
  readonly projectId: string;
  readonly stage: StageNumber;
  readonly done: boolean;
  readonly reviews: Readonly<Record<StageNumber, ReviewState | undefined>>;
  readonly decisions: readonly DecisionRecord[];
  readonly authorizedPrincipals: Readonly<Record<StageNumber, readonly string[]>>;
  readonly stageOrder: readonly StageNumber[];
  readonly reviewCounts: Readonly<Record<StageNumber, number>>;
  readonly principalId: unknown;
  readonly decision: unknown;
  readonly freeze: Freeze | null;
}

function isQuorumOutcome(value: unknown): value is QuorumDecisionEvidence["outcome"] {
  return value === "proceed" || value === "block" || value === "revise";
}

/** Structural check for `ApprovePayload["evidence"]` at stage 5. */
export function isStage5Evidence(value: unknown): value is Stage5Evidence {
  if (!isRecord(value)) return false;
  if (typeof value.quorum !== "number" || !Number.isInteger(value.quorum) || value.quorum < 0) return false;
  if (!Array.isArray(value.stakeholders) || !value.stakeholders.every((s) => typeof s === "string")) return false;
  if (!Array.isArray(value.decisions)) return false;
  return value.decisions.every(
    (d) =>
      isRecord(d) &&
      typeof d.by === "string" &&
      isQuorumOutcome(d.outcome) &&
      typeof d.packageArtifactId === "string" &&
      typeof d.packageVersion === "number",
  );
}

/**
 * Pure fold of stage 5 evidence into the quorum outcome. Only the LATEST
 * decision per stakeholder counts (`decisions` is oldest-first); a decision
 * by someone not in `stakeholders` is ignored. Quorum 0 with no blockers is
 * met (solo policy) -- exported so both the reducer's stage rule and
 * `apps/web/src/pages/audiences.tsx`'s banner read the identical outcome.
 */
export function quorumState(evidence: Stage5Evidence): QuorumState {
  const latestByStakeholder = new Map<string, QuorumDecisionEvidence>();
  for (const decision of evidence.decisions) {
    if (!evidence.stakeholders.includes(decision.by)) continue;
    latestByStakeholder.set(decision.by, decision);
  }
  const blocked = evidence.stakeholders.filter((who) => {
    const decision = latestByStakeholder.get(who);
    return decision !== undefined && decision.outcome !== "proceed";
  });
  const missing = evidence.stakeholders.filter((who) => !latestByStakeholder.has(who));
  const proceeded = evidence.stakeholders.filter((who) => latestByStakeholder.get(who)?.outcome === "proceed").length;
  return { met: blocked.length === 0 && proceeded >= evidence.quorum, proceeded, required: evidence.quorum, blocked, missing };
}

const stage5Rule: StageRule = (_state, payload) => {
  if (!isStage5Evidence(payload.evidence)) return "evidence_missing";
  return quorumState(payload.evidence).met ? null : "quorum_not_met";
};

/** Structural check for `ApprovePayload["evidence"]` at stage 7. */
export function isStage7Evidence(value: unknown): value is Stage7Evidence {
  if (!isRecord(value)) return false;
  if (typeof value.target !== "string" || value.target.length === 0) return false;
  if (!Array.isArray(value.frozen)) return false;
  return value.frozen.every(
    (f) => isRecord(f) && isStageNumber(f.stage) && typeof f.artifactId === "string" && typeof f.version === "number" && typeof f.sha256 === "string",
  );
}

const EARLIER_STAGES = [1, 2, 3, 4, 5, 6] as const;

const stage7Rule: StageRule = (state, payload) => {
  const evidence = payload.evidence;
  const target = isRecord(evidence) && typeof evidence.target === "string" ? evidence.target : "";
  if (target.length === 0) return "target_missing";
  if (state.freeze) return "frozen_already";
  if (!isStage7Evidence(evidence)) return "evidence_missing";
  const approvedStages = EARLIER_STAGES.filter((s) => state.reviews[s]?.status === "approved");
  if (evidence.frozen.length !== approvedStages.length) return "evidence_missing";
  for (const stage of approvedStages) {
    const review = state.reviews[stage]!;
    const entry = evidence.frozen.find((f) => f.stage === stage);
    if (!entry || entry.artifactId !== review.artifactId || entry.version !== review.version || entry.sha256 !== review.sha256) {
      return "evidence_missing";
    }
  }
  return null;
};

/**
 * Seam for stage-specific approval rules, consulted after every
 * structural/reference check on an `approve` decision passes and before the
 * reducer commits the approval: stage 5's stakeholder quorum and stage 7's
 * cost/target freeze (CL-8690/CL-8691).
 */
export type StageRule = (state: ProjectState, payload: ApprovePayload, principalId: string) => RefusalCode | null;
export const stageRules: Readonly<Record<StageNumber, StageRule>> = { 5: stage5Rule, 7: stage7Rule };

/** Why `allowed.approve` is false, or null once it is true. `no_open_review`
 *  is the ordinary state before the client has named anything reviewable; a
 *  stage rule's own verdict (`quorum_not_met`, `target_missing`, ...)
 *  surfaces only once an approve attempt against the CURRENTLY open review
 *  has actually been refused for it -- the workflow never sees a rule's
 *  evidence before an attempt is made, so it cannot predict the verdict any
 *  earlier than that (CL-8687: it never reads an artifact or a project's
 *  policy). The single place this is derived; `foldProjectWorkflow`
 *  (`apps/web/src/project-workflow.ts`) surfaces it on `allowed`. */
export type ApproveReason = RefusalCode | "no_open_review";

export function approveReason(state: ProjectState): ApproveReason | null {
  if (state.done) return "already_done";
  const openReview = state.reviews[state.stage]?.status === "open" ? state.reviews[state.stage] : undefined;
  if (!openReview) return "no_open_review";
  const refusal = [...state.decisions]
    .reverse()
    .find((d) => !d.accepted && d.kind === "approve" && d.stage === state.stage && d.reviewId === openReview.reviewId);
  return (refusal?.reason as ApproveReason | undefined) ?? null;
}

const APPROVE_REASON_TEXT: Readonly<Record<ApproveReason, string>> = {
  no_open_review: "Nothing is ready to review yet.",
  duplicate: "That decision was already recorded.",
  unauthorized: "You are not authorized to decide this stage.",
  wrong_project: "That decision was for a different project.",
  wrong_stage: "The project has moved to a different stage.",
  stale_review: "The reviewed material has changed since this review opened.",
  wrong_artifact: "The reviewed material has changed since this review opened.",
  stale_version: "A newer version is under review.",
  hash_mismatch: "The reviewed material has changed since this review opened.",
  invalid_target_stage: "That target stage is not valid.",
  already_done: "This project is already finished.",
  evidence_missing: "The recorded decisions don't match what this approval expects.",
  quorum_not_met: "The stakeholder quorum has not been met yet.",
  target_missing: "Choose a target before approving.",
  frozen_already: "This build is already frozen.",
};

/** `approveReason`'s code, in plain language -- the one place stage 5's
 *  quorum breakdown and any other UI copy reads it from, rather than
 *  recomputing `quorumState` itself. `refusal` is `ProjectWorkflowView`'s
 *  own `lastRefusal` when it matches this reason; its `quorum` field (set by
 *  `refusalExtra`) names which stakeholders blocked it. */
export function approveReasonText(reason: ApproveReason, refusal: DecisionRecord | null): string {
  if (reason === "quorum_not_met" && refusal?.quorum) {
    const { blocked, proceeded, required } = refusal.quorum;
    if (blocked.length > 0) return `${blocked.join(" and ")} ${blocked.length === 1 ? "has" : "have"} blocked this.`;
    if (proceeded === 0) return "No decisions recorded yet.";
    return `${proceeded} of ${required} stakeholders have said proceed.`;
  }
  return APPROVE_REASON_TEXT[reason] ?? reason;
}

function stateOf(input: ApplyDecisionInput): ProjectState {
  return {
    projectId: input.projectId,
    stage: input.stage,
    done: input.done,
    reviews: input.reviews,
    decisions: input.decisions,
    authorizedPrincipals: input.authorizedPrincipals,
    stageOrder: input.stageOrder,
    reviewCounts: input.reviewCounts,
    freeze: input.freeze,
  };
}

function refused(
  state: ProjectState,
  payload: DecisionPayload,
  principalId: string,
  code: RefusalCode,
  extra: Partial<Pick<DecisionRecord, "quorum" | "target">> = {},
): ProjectState {
  const record: DecisionRecord = {
    decisionId: payload.decisionId,
    kind: payload.kind,
    stage: payload.stage,
    accepted: false,
    reason: code,
    principalId,
    at: payload.at,
    ...(payload.kind === "approve" ? { reviewId: payload.reviewId } : {}),
    ...(payload.kind !== "send_back" ? { artifactId: payload.artifactId, version: payload.version, sha256: payload.sha256 } : {}),
    ...(payload.kind === "send_back" && payload.targetStage !== undefined ? { targetStage: payload.targetStage } : {}),
    ...extra,
  };
  return { ...state, decisions: [...state.decisions, record] };
}

/** A stage-rule refusal's own evidence breakdown, attached to the refusal
 *  record so `allowed.approveReason`'s UI copy can explain WHY (which
 *  stakeholders block quorum, what target was missing) without re-deriving
 *  it from the evidence itself -- the workflow already computed it once. */
function refusalExtra(stage: StageNumber, code: RefusalCode, evidence: unknown): Partial<Pick<DecisionRecord, "quorum" | "target">> {
  if (code === "quorum_not_met" && stage === 5 && isStage5Evidence(evidence)) {
    const q = quorumState(evidence);
    return { quorum: { proceeded: q.proceeded, required: q.required, blocked: q.blocked } };
  }
  if (code === "target_missing" && isRecord(evidence) && typeof evidence.target === "string" && evidence.target.length > 0) {
    return { target: evidence.target };
  }
  return {};
}

function nextReviewId(stage: StageNumber, count: number): string {
  return `stage-${String(stage)}-review-${String(count)}`;
}

/**
 * Pure reducer over `ProjectState`. No effects, no clock, no randomness:
 * every timestamp arrives on the payload as data. Always returns a state
 * (never throws on a bad decision) -- refusal is a value, not an exception.
 */
export function applyDecision(input: ApplyDecisionInput): ProjectState {
  const state = stateOf(input);
  const principalId = typeof input.principalId === "string" ? input.principalId : null;
  const payload = validateDecisionShape(input.decision);

  if (payload === null || principalId === null) {
    // Cannot trust decisionId enough to record a refusal against it.
    return state;
  }
  if (state.decisions.some((d) => d.decisionId === payload.decisionId)) {
    return refused(state, payload, principalId, "duplicate");
  }

  const authorized = state.authorizedPrincipals[state.stage] ?? [];
  if (!authorized.includes(principalId)) {
    return refused(state, payload, principalId, "unauthorized");
  }
  if (payload.projectId !== state.projectId) {
    return refused(state, payload, principalId, "wrong_project");
  }
  if (state.done) {
    return refused(state, payload, principalId, "already_done");
  }
  if (payload.stage !== state.stage) {
    return refused(state, payload, principalId, "wrong_stage");
  }

  if (payload.kind === "open_review") {
    const reviews: Record<StageNumber, ReviewState | undefined> = { ...state.reviews };
    const previous = reviews[state.stage];
    if (previous && previous.status !== "stale") reviews[state.stage] = { ...previous, status: "stale" };
    const count = (state.reviewCounts[state.stage] ?? 0) + 1;
    reviews[state.stage] = {
      reviewId: nextReviewId(state.stage, count),
      artifactId: payload.artifactId,
      version: payload.version,
      sha256: payload.sha256,
      status: "open",
    };
    const record: DecisionRecord = {
      decisionId: payload.decisionId,
      kind: "open_review",
      stage: payload.stage,
      accepted: true,
      principalId,
      at: payload.at,
      artifactId: payload.artifactId,
      version: payload.version,
      sha256: payload.sha256,
    };
    return {
      ...state,
      reviews,
      decisions: [...state.decisions, record],
      reviewCounts: { ...state.reviewCounts, [state.stage]: count },
    };
  }

  if (payload.kind === "approve") {
    const review = state.reviews[state.stage];
    if (!review || review.status !== "open" || payload.reviewId !== review.reviewId) {
      return refused(state, payload, principalId, "stale_review");
    }
    if (payload.artifactId !== review.artifactId) {
      return refused(state, payload, principalId, "wrong_artifact");
    }
    if (payload.version !== review.version) {
      return refused(state, payload, principalId, "stale_version");
    }
    if (payload.sha256 !== review.sha256) {
      return refused(state, payload, principalId, "hash_mismatch");
    }
    const rule = stageRules[state.stage];
    if (rule) {
      const code = rule(state, payload, principalId);
      if (code) return refused(state, payload, principalId, code, refusalExtra(state.stage, code, payload.evidence));
    }

    const approvedReviews: Record<StageNumber, ReviewState | undefined> = {
      ...state.reviews,
      [state.stage]: { ...review, status: "approved" },
    };
    const quorum = state.stage === 5 && isStage5Evidence(payload.evidence) ? quorumState(payload.evidence) : null;
    const freeze: Freeze | null =
      state.stage === 7 && isStage7Evidence(payload.evidence)
        ? { target: payload.evidence.target, frozen: payload.evidence.frozen, decisionId: payload.decisionId }
        : state.freeze;
    const record: DecisionRecord = {
      decisionId: payload.decisionId,
      kind: "approve",
      stage: payload.stage,
      accepted: true,
      principalId,
      at: payload.at,
      reviewId: payload.reviewId,
      artifactId: payload.artifactId,
      version: payload.version,
      sha256: payload.sha256,
      ...(quorum ? { quorum: { proceeded: quorum.proceeded, required: quorum.required, blocked: quorum.blocked } } : {}),
      ...(freeze && freeze !== state.freeze ? { target: freeze.target } : {}),
    };
    const currentIndex = state.stageOrder.indexOf(state.stage);
    const nextStage = state.stageOrder[currentIndex + 1];
    if (nextStage === undefined) {
      return { ...state, reviews: approvedReviews, decisions: [...state.decisions, record], done: true, freeze };
    }
    return { ...state, stage: nextStage, reviews: approvedReviews, decisions: [...state.decisions, record], freeze };
  }

  // send_back
  const targetStage = payload.targetStage ?? (state.stage === state.stageOrder[state.stageOrder.length - 1] ? state.stageOrder[state.stageOrder.length - 2] : undefined);
  if (targetStage === undefined || targetStage > state.stage || !state.stageOrder.includes(targetStage)) {
    return refused(state, payload, principalId, "invalid_target_stage");
  }
  const reviews: Record<StageNumber, ReviewState | undefined> = { ...state.reviews };
  for (const [key, review] of Object.entries(reviews)) {
    if (Number(key) >= targetStage && review && review.status !== "stale") {
      reviews[Number(key)] = { ...review, status: "stale" };
    }
  }
  const record: DecisionRecord = {
    decisionId: payload.decisionId,
    kind: "send_back",
    stage: payload.stage,
    accepted: true,
    principalId,
    at: payload.at,
    targetStage,
    reason: payload.reason,
  };
  const freeze = targetStage <= 7 ? null : state.freeze;
  return { ...state, stage: targetStage, reviews, decisions: [...state.decisions, record], freeze };
}

export interface InitProjectStagePayload {
  readonly stage: StageNumber;
  readonly authorizedPrincipalIds: readonly string[];
}

export interface InitProjectPayload {
  readonly projectId: string;
  readonly stages: readonly InitProjectStagePayload[];
}

/** Builds the loop's initial carry from the workflow's trigger payload. No
 *  review is open yet -- the first `open_review` decision opens stage 1's. */
export function initProjectState(payload: InitProjectPayload): ProjectState {
  const firstStage = payload.stages[0];
  if (!firstStage) throw new Error("initProjectState requires at least one stage");
  const authorizedPrincipals: Record<StageNumber, readonly string[]> = {};
  for (const s of payload.stages) authorizedPrincipals[s.stage] = s.authorizedPrincipalIds;
  return {
    projectId: payload.projectId,
    stage: firstStage.stage,
    done: false,
    reviews: {},
    decisions: [],
    authorizedPrincipals,
    stageOrder: payload.stages.map((s) => s.stage),
    reviewCounts: {},
    freeze: null,
  };
}
