import { createHash } from "node:crypto";

export type StageNumber = number;
export type DecisionOutcome = "approve" | "send_back";
export type ReviewStatus = "open" | "approved" | "stale";

export interface ReviewState {
  readonly reviewId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string | null;
  readonly status: ReviewStatus;
}

export interface DecisionRecord {
  readonly decisionId: string;
  readonly stage: StageNumber;
  readonly outcome: DecisionOutcome;
  readonly accepted: boolean;
  readonly reason?: string;
  readonly principalId: string;
  readonly targetStage?: StageNumber;
}

/**
 * The carried loop state. `authorizedPrincipals`/`stageOrder`/`reviewCounts`
 * are static-config and bookkeeping the reducer needs on every decision and
 * every advance/send-back; they ride along on the same carry because a loop
 * body's `trigger.payload` is exactly what carry threads forward and there is
 * nowhere else to keep them replay-safe.
 */
export interface ProjectState {
  readonly projectId: string;
  readonly stage: StageNumber;
  readonly done: boolean;
  readonly reviews: Readonly<Record<StageNumber, ReviewState>>;
  readonly decisions: readonly DecisionRecord[];
  readonly authorizedPrincipals: Readonly<Record<StageNumber, readonly string[]>>;
  readonly stageOrder: readonly StageNumber[];
  readonly reviewCounts: Readonly<Record<StageNumber, number>>;
}

export interface DecisionPayload {
  readonly decisionId: string;
  readonly projectId: string;
  readonly stage: StageNumber;
  readonly reviewId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
  readonly outcome: DecisionOutcome;
  readonly targetStage?: StageNumber;
  readonly reason?: string;
}

export type RefusalCode =
  | "invalid_shape"
  | "duplicate_decision"
  | "unauthorized"
  | "wrong_project"
  | "wrong_stage"
  | "stale_review"
  | "wrong_artifact"
  | "stale_version"
  | "artifact_unreadable"
  | "hash_mismatch"
  | "invalid_target_stage";

export type ReadArtifact = (
  artifactId: string,
  version: number,
) => Promise<{ content: string } | null>;

export function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation only: types and presence, plus the outcome-specific
 * shape rule (`send_back` requires `reason` and an integer `targetStage`).
 * Extra/unknown fields (a nested `principalId`, e.g.) are never read and
 * never rejected -- ignoring them is how the top-level stamp stays the only
 * source of principal identity.
 */
export function validateDecisionShape(value: unknown): DecisionPayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.decisionId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.stage !== "number" ||
    !Number.isInteger(value.stage) ||
    typeof value.reviewId !== "string" ||
    typeof value.artifactId !== "string" ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    typeof value.sha256 !== "string" ||
    (value.outcome !== "approve" && value.outcome !== "send_back")
  ) {
    return null;
  }
  if (value.outcome === "send_back") {
    if (typeof value.reason !== "string" || value.reason.length === 0) return null;
    if (typeof value.targetStage !== "number" || !Number.isInteger(value.targetStage)) return null;
  }
  const payload: DecisionPayload = {
    decisionId: value.decisionId,
    projectId: value.projectId,
    stage: value.stage,
    reviewId: value.reviewId,
    artifactId: value.artifactId,
    version: value.version,
    sha256: value.sha256,
    outcome: value.outcome,
    ...(typeof value.targetStage === "number" ? { targetStage: value.targetStage } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
  return payload;
}

export interface ApplyDecisionInput {
  readonly projectId: string;
  readonly stage: StageNumber;
  readonly done: boolean;
  readonly reviews: Readonly<Record<StageNumber, ReviewState>>;
  readonly decisions: readonly DecisionRecord[];
  readonly authorizedPrincipals: Readonly<Record<StageNumber, readonly string[]>>;
  readonly stageOrder: readonly StageNumber[];
  readonly reviewCounts: Readonly<Record<StageNumber, number>>;
  readonly principalId: unknown;
  readonly decision: unknown;
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
  };
}

function refused(
  state: ProjectState,
  payload: DecisionPayload,
  principalId: string,
  code: RefusalCode,
): ProjectState {
  const record: DecisionRecord = {
    decisionId: payload.decisionId,
    stage: payload.stage,
    outcome: payload.outcome,
    accepted: false,
    reason: code,
    principalId,
    ...(payload.targetStage !== undefined ? { targetStage: payload.targetStage } : {}),
  };
  return { ...state, decisions: [...state.decisions, record] };
}

function nextReviewId(stage: StageNumber, count: number): string {
  return `stage-${String(stage)}-review-${String(count)}`;
}

function nextArtifactId(projectId: string, stage: StageNumber): string {
  return `${projectId}-stage-${String(stage)}-artifact`;
}

/**
 * Pure reducer over `ProjectState`. The only effect is `readArtifact`,
 * injected by the caller; no clock, no randomness. Always returns a state
 * (never throws on a bad decision) -- refusal is a value, not an exception.
 */
export async function applyDecision(
  input: ApplyDecisionInput,
  readArtifact: ReadArtifact,
): Promise<ProjectState> {
  const state = stateOf(input);
  const principalId = typeof input.principalId === "string" ? input.principalId : null;
  const payload = validateDecisionShape(input.decision);

  if (payload === null || principalId === null) {
    // Cannot trust decisionId enough to record a refusal against it.
    return state;
  }
  if (state.decisions.some((d) => d.decisionId === payload.decisionId)) {
    return state;
  }

  const authorized = state.authorizedPrincipals[state.stage] ?? [];
  if (!authorized.includes(principalId)) {
    return refused(state, payload, principalId, "unauthorized");
  }
  if (payload.projectId !== state.projectId) {
    return refused(state, payload, principalId, "wrong_project");
  }
  if (payload.stage !== state.stage) {
    return refused(state, payload, principalId, "wrong_stage");
  }
  const review = state.reviews[state.stage];
  if (!review || payload.reviewId !== review.reviewId) {
    return refused(state, payload, principalId, "stale_review");
  }
  if (payload.artifactId !== review.artifactId) {
    return refused(state, payload, principalId, "wrong_artifact");
  }
  if (payload.version !== review.version) {
    return refused(state, payload, principalId, "stale_version");
  }

  const artifact = await readArtifact(payload.artifactId, payload.version);
  if (artifact === null) {
    return refused(state, payload, principalId, "artifact_unreadable");
  }
  const actualSha256 = contentSha256(artifact.content);
  if (actualSha256 !== payload.sha256) {
    return refused(state, payload, principalId, "hash_mismatch");
  }
  if (review.sha256 !== null && actualSha256 !== review.sha256) {
    return refused(state, payload, principalId, "hash_mismatch");
  }

  if (payload.outcome === "send_back") {
    const targetStage = payload.targetStage as StageNumber;
    if (targetStage > state.stage || !state.stageOrder.includes(targetStage)) {
      return refused(state, payload, principalId, "invalid_target_stage");
    }
    const reviews: Record<StageNumber, ReviewState> = { ...state.reviews };
    for (const [key, r] of Object.entries(reviews)) {
      const stageKey = Number(key);
      if (stageKey >= targetStage && r.status !== "stale") {
        reviews[stageKey] = { ...r, status: "stale" };
      }
    }
    const count = (state.reviewCounts[targetStage] ?? 0) + 1;
    reviews[targetStage] = {
      reviewId: nextReviewId(targetStage, count),
      artifactId: nextArtifactId(state.projectId, targetStage),
      version: count,
      sha256: null,
      status: "open",
    };
    const record: DecisionRecord = {
      decisionId: payload.decisionId,
      stage: payload.stage,
      outcome: "send_back",
      accepted: true,
      principalId,
      targetStage,
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    };
    return {
      ...state,
      stage: targetStage,
      reviews,
      decisions: [...state.decisions, record],
      reviewCounts: { ...state.reviewCounts, [targetStage]: count },
    };
  }

  // approve
  const approvedReviews: Record<StageNumber, ReviewState> = {
    ...state.reviews,
    [state.stage]: { ...review, sha256: actualSha256, status: "approved" },
  };
  const record: DecisionRecord = {
    decisionId: payload.decisionId,
    stage: payload.stage,
    outcome: "approve",
    accepted: true,
    principalId,
  };
  const currentIndex = state.stageOrder.indexOf(state.stage);
  const nextStage = state.stageOrder[currentIndex + 1];
  if (nextStage === undefined) {
    return {
      ...state,
      reviews: approvedReviews,
      decisions: [...state.decisions, record],
      done: true,
    };
  }
  const count = (state.reviewCounts[nextStage] ?? 0) + 1;
  const reviews: Record<StageNumber, ReviewState> = {
    ...approvedReviews,
    [nextStage]: {
      reviewId: nextReviewId(nextStage, count),
      artifactId: nextArtifactId(state.projectId, nextStage),
      version: count,
      sha256: null,
      status: "open",
    },
  };
  return {
    ...state,
    stage: nextStage,
    reviews,
    decisions: [...state.decisions, record],
    reviewCounts: { ...state.reviewCounts, [nextStage]: count },
  };
}

export interface InitProjectStagePayload {
  readonly stage: StageNumber;
  readonly authorizedPrincipalIds: readonly string[];
}

export interface InitProjectPayload {
  readonly projectId: string;
  readonly stages: readonly InitProjectStagePayload[];
  readonly firstReview: { readonly reviewId: string; readonly artifactId: string; readonly version: number };
}

/** Builds the loop's initial carry from the workflow's trigger payload. */
export function initProjectState(payload: InitProjectPayload): ProjectState {
  const firstStage = payload.stages[0];
  if (!firstStage) throw new Error("initProjectState requires at least one stage");
  const authorizedPrincipals: Record<StageNumber, readonly string[]> = {};
  for (const s of payload.stages) authorizedPrincipals[s.stage] = s.authorizedPrincipalIds;
  return {
    projectId: payload.projectId,
    stage: firstStage.stage,
    done: false,
    reviews: {
      [firstStage.stage]: {
        reviewId: payload.firstReview.reviewId,
        artifactId: payload.firstReview.artifactId,
        version: payload.firstReview.version,
        sha256: null,
        status: "open",
      },
    },
    decisions: [],
    authorizedPrincipals,
    stageOrder: payload.stages.map((s) => s.stage),
    reviewCounts: { [firstStage.stage]: 1 },
  };
}
