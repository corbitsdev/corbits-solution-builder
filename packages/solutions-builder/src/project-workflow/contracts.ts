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
  | "already_done";

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
}

/**
 * Seam for stage-specific approval rules (stage 5 quorum, stage 7 cost
 * freeze, ...), consulted after every structural/reference check on an
 * `approve` decision passes and before the reducer commits the approval. No
 * rules are registered yet.
 */
export type StageRule = (state: ProjectState, payload: ApprovePayload, principalId: string) => RefusalCode | null;
export const stageRules: Readonly<Record<StageNumber, StageRule>> = {};

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
  };
}

function refused(state: ProjectState, payload: DecisionPayload, principalId: string, code: RefusalCode): ProjectState {
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
  };
  return { ...state, decisions: [...state.decisions, record] };
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
      if (code) return refused(state, payload, principalId, code);
    }

    const approvedReviews: Record<StageNumber, ReviewState | undefined> = {
      ...state.reviews,
      [state.stage]: { ...review, status: "approved" },
    };
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
    };
    const currentIndex = state.stageOrder.indexOf(state.stage);
    const nextStage = state.stageOrder[currentIndex + 1];
    if (nextStage === undefined) {
      return { ...state, reviews: approvedReviews, decisions: [...state.decisions, record], done: true };
    }
    return { ...state, stage: nextStage, reviews: approvedReviews, decisions: [...state.decisions, record] };
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
  return { ...state, stage: targetStage, reviews, decisions: [...state.decisions, record] };
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
  };
}
