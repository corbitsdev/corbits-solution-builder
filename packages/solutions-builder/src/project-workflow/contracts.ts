import { checkStackCitations, type RequirementEntry, type RequirementKind, type StackChoice, type StackRecord } from "../stack.js";

export type StageNumber = number;
/** `mint_requirements` (CL-8862) mints `ProjectState.requirements` once, from
 *  items the caller parsed out of the approved stage-6 requirements document
 *  -- the workflow never reads that document itself. It carries no
 *  reviewId/artifactId: it is not a review decision, just the one place ids
 *  become authoritative before the Architect runs. */
export type DecisionKind = "open_review" | "approve" | "send_back" | "mint_requirements" | "audience";
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
  /** `audience` decisions only: which stakeholder, and their own
   *  proceed/revise/reject and optional note. */
  readonly audience?: string;
  readonly outcome?: AudienceVote["decision"];
  readonly note?: string;
}

/** One stakeholder's own proceed/revise/reject, as carried by an `audience`
 *  decision and folded into `ProjectState.audienceDecisions` -- keyed by
 *  audience name, latest decisionId per audience wins. */
export interface AudienceVote {
  readonly audience: string;
  readonly decision: "proceed" | "revise" | "reject";
  readonly note: string;
  readonly principalId: string;
  readonly at: string;
  readonly decisionId: string;
}

/** Stage 5's quorum policy: the required proceed count and the named
 *  stakeholder list. Captured onto `ProjectState.audiencePolicy` by the
 *  `open_review` decision that opens a stage-5 review (see that payload's
 *  `policy` field) so an edit to the stakeholder list after a review has
 *  opened can never change the gate that review is checked against. */
export interface AudiencePolicy {
  readonly quorum: number;
  readonly stakeholders: readonly string[];
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
  /** The Architect's stack decision (kit.ts's `## Stack` block), citing only
   *  `ProjectState.requirements` ids. Validated against them by `stage7Rule`. */
  readonly stack: StackRecord;
}

/** The freeze recorded on `ProjectState` once stage 7 is approved: the
 *  chosen target, the frozen references and the stack, plus the decision
 *  that made them binding. Cleared by a send-back to stage <= 7. */
export interface Freeze {
  readonly target: string;
  readonly frozen: readonly FrozenReference[];
  readonly stack: StackRecord;
  readonly decisionId: string;
}

/** The captured policy and the recorded votes' outcome as `quorumState`
 *  reports it: pure, no lookups -- the reducer's stage-5 rule and the view
 *  `apps/web/src/project-workflow.ts`'s `foldProjectWorkflow` exposes (read
 *  by `apps/web/src/pages/audiences.tsx`'s banner) both read this from
 *  `@solutions-builder/app/project-workflow/contracts` so the banner text
 *  and the refusal agree on what "met" means. */
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
  /** Requirement ids minted by `mint_requirements`, once, before the
   *  Architect runs. Cleared by a send-back to stage <= 6 (CL-8862). */
  readonly requirements: readonly RequirementEntry[];
  /** Stage 5's quorum policy, captured by the `open_review` decision that
   *  opened the currently (or most recently) open stage-5 review; null
   *  before any stage-5 review has opened. */
  readonly audiencePolicy: AudiencePolicy | null;
  /** Every stakeholder's latest `audience` vote, keyed by audience name. */
  readonly audienceDecisions: Readonly<Record<string, AudienceVote>>;
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
  /** Stage 5 only: the quorum policy in effect right now, captured onto
   *  `ProjectState.audiencePolicy` -- so an edit to the stakeholder list
   *  after this review opens can never change the gate it is checked
   *  against. Ignored at every other stage. */
  readonly policy?: AudiencePolicy;
}

export interface ApprovePayload extends DecisionCommon {
  readonly kind: "approve";
  readonly reviewId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
  /** Stage-rule input (`Stage7Evidence`), never read by the reducer's own
   *  structural/reference checks -- only by `stageRules`. Stage 5 needs
   *  none: its rule reads `ProjectState.audiencePolicy`/`audienceDecisions`
   *  directly. */
  readonly evidence?: unknown;
}

export interface AudiencePayload extends DecisionCommon {
  readonly kind: "audience";
  readonly audience: string;
  readonly decision: "proceed" | "revise" | "reject";
  readonly note?: string;
}

export interface SendBackPayload extends DecisionCommon {
  readonly kind: "send_back";
  readonly targetStage?: StageNumber;
  readonly reason: string;
}

export interface MintRequirementsPayload extends DecisionCommon {
  readonly kind: "mint_requirements";
  /** Items the caller parsed from the approved requirements document
   *  (`P/requirements.ts`'s `extractRequirementItems`); the reducer mints
   *  the id, deterministically, per kind in order (`FR-1`, `FR-2`, ...). */
  readonly items: readonly { readonly kind: RequirementKind; readonly text: string }[];
}

export type DecisionPayload = OpenReviewPayload | ApprovePayload | SendBackPayload | MintRequirementsPayload | AudiencePayload;

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
  | "frozen_already"
  | "requirements_already_minted"
  | "stack_missing"
  | "stack_uncited"
  | "stack_unknown_requirement";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStageNumber(value: unknown): value is StageNumber {
  return typeof value === "number" && Number.isInteger(value);
}

const REQUIREMENT_KINDS: readonly RequirementKind[] = ["FR", "NFR", "IR", "AC"];

function isRequirementItem(value: unknown): value is { kind: RequirementKind; text: string } {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    REQUIREMENT_KINDS.includes(value.kind as RequirementKind)
  );
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
    if (value.policy !== undefined && !isAudiencePolicy(value.policy)) return null;
    return {
      ...common,
      kind: "open_review",
      artifactId: value.artifactId,
      version: value.version,
      sha256: value.sha256,
      ...(value.policy !== undefined ? { policy: value.policy } : {}),
    };
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

  if (value.kind === "mint_requirements") {
    if (!Array.isArray(value.items) || value.items.length === 0 || !value.items.every(isRequirementItem)) return null;
    return { ...common, kind: "mint_requirements", items: value.items as { kind: RequirementKind; text: string }[] };
  }

  if (value.kind === "audience") {
    if (typeof value.audience !== "string" || value.audience.length === 0) return null;
    if (value.decision !== "proceed" && value.decision !== "revise" && value.decision !== "reject") return null;
    if (value.note !== undefined && typeof value.note !== "string") return null;
    return {
      ...common,
      kind: "audience",
      audience: value.audience,
      decision: value.decision,
      ...(value.note !== undefined ? { note: value.note } : {}),
    };
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
  readonly requirements: readonly RequirementEntry[];
  readonly audiencePolicy: AudiencePolicy | null;
  readonly audienceDecisions: Readonly<Record<string, AudienceVote>>;
}

/** Structural check for `OpenReviewPayload["policy"]` at stage 5. */
export function isAudiencePolicy(value: unknown): value is AudiencePolicy {
  if (!isRecord(value)) return false;
  if (typeof value.quorum !== "number" || !Number.isInteger(value.quorum) || value.quorum < 0) return false;
  return Array.isArray(value.stakeholders) && value.stakeholders.every((s) => typeof s === "string");
}

/**
 * Pure fold of the captured policy and the recorded votes into the quorum
 * outcome. `votes` already carries only the latest vote per audience (the
 * reducer overwrites on each `audience` decision), and a vote by someone not
 * in `policy.stakeholders` is ignored. Quorum 0 with no blockers is met
 * (solo policy) -- exported so both the reducer's stage rule and
 * `foldProjectWorkflow`'s view (read by `apps/web/src/pages/audiences.tsx`'s
 * banner) read the identical outcome.
 */
export function quorumState(policy: AudiencePolicy, votes: Readonly<Record<string, AudienceVote>>): QuorumState {
  const blocked = policy.stakeholders.filter((who) => {
    const vote = votes[who];
    return vote !== undefined && vote.decision !== "proceed";
  });
  const missing = policy.stakeholders.filter((who) => votes[who] === undefined);
  const proceeded = policy.stakeholders.filter((who) => votes[who]?.decision === "proceed").length;
  return { met: blocked.length === 0 && proceeded >= policy.quorum, proceeded, required: policy.quorum, blocked, missing };
}

/** Stage 5's own rule reads `ProjectState` directly -- the policy an
 *  `open_review` captured and the votes recorded since -- never the
 *  approve's own `evidence` (CL-8870: an edit to the stakeholder list after
 *  a review opens can never change the gate that review is checked
 *  against). */
const stage5Rule: StageRule = (state) => {
  if (!state.audiencePolicy) return "evidence_missing";
  return quorumState(state.audiencePolicy, state.audienceDecisions).met ? null : "quorum_not_met";
};

function isStackChoiceShape(value: unknown): value is StackChoice {
  return (
    isRecord(value) &&
    typeof value.choice === "string" &&
    typeof value.reason === "string" &&
    Array.isArray(value.cites) &&
    value.cites.every((c) => typeof c === "string")
  );
}

const STACK_MODES: readonly StackRecord["mode"][] = ["plain", "inference", "agent", "local-workflow", "durable-workflow", "hub"];

/** Structural check for the `StackRecord` an approve's evidence carries.
 *  Not a re-implementation of lane C's `parseStackRecord` (`P/stack.ts`,
 *  markdown -> StackRecord with arktype): this only guards the reducer
 *  against a malformed JSON payload before `checkStackCitations` walks it. */
function isStackRecordShape(value: unknown): value is StackRecord {
  if (!isRecord(value)) return false;
  if (!STACK_MODES.includes(value.mode as StackRecord["mode"])) return false;
  if (!isStackChoiceShape(value.runtime)) return false;
  if (value.ui !== null && !isStackChoiceShape(value.ui)) return false;
  if (value.storage !== null && !isStackChoiceShape(value.storage)) return false;
  if (value.auth !== null && !isStackChoiceShape(value.auth)) return false;
  if (!isStackChoiceShape(value.packaging) || typeof (value.packaging as unknown as Record<string, unknown>).kind !== "string") return false;
  if (
    !Array.isArray(value.packages) ||
    !value.packages.every((p) => isStackChoiceShape(p) && typeof (p as unknown as Record<string, unknown>).name === "string")
  ) {
    return false;
  }
  return Array.isArray(value.deferred) && value.deferred.every((d) => typeof d === "string");
}

/** Structural check for `ApprovePayload["evidence"]` at stage 7. */
export function isStage7Evidence(value: unknown): value is Stage7Evidence {
  if (!isRecord(value)) return false;
  if (typeof value.target !== "string" || value.target.length === 0) return false;
  if (!Array.isArray(value.frozen)) return false;
  if (!isStackRecordShape(value.stack)) return false;
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
  if (isRecord(evidence) && !isStackRecordShape(evidence.stack)) return "stack_missing";
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
  const requirementIds = new Set(state.requirements.map((r) => r.id));
  const problems = checkStackCitations(evidence.stack, requirementIds);
  if (problems.length > 0) {
    return problems.some((p) => p.problem === "unknown_requirement") ? "stack_unknown_requirement" : "stack_uncited";
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
  requirements_already_minted: "The requirement ids are already set for this project.",
  stack_missing: "The plan's stack decision is missing.",
  stack_uncited: "Every part of the stack must cite the requirement that forces it.",
  stack_unknown_requirement: "The stack cites a requirement id that does not exist.",
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
    requirements: input.requirements,
    audiencePolicy: input.audiencePolicy,
    audienceDecisions: input.audienceDecisions,
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
    ...(payload.kind === "open_review" || payload.kind === "approve"
      ? { artifactId: payload.artifactId, version: payload.version, sha256: payload.sha256 }
      : {}),
    ...(payload.kind === "send_back" && payload.targetStage !== undefined ? { targetStage: payload.targetStage } : {}),
    ...(payload.kind === "audience"
      ? { audience: payload.audience, outcome: payload.decision, ...(payload.note ? { note: payload.note } : {}) }
      : {}),
    ...extra,
  };
  return { ...state, decisions: [...state.decisions, record] };
}

/** A stage-rule refusal's own evidence breakdown, attached to the refusal
 *  record so `allowed.approveReason`'s UI copy can explain WHY (which
 *  stakeholders block quorum, what target was missing) without re-deriving
 *  it from the evidence itself -- the workflow already computed it once. */
function refusalExtra(state: ProjectState, code: RefusalCode, evidence: unknown): Partial<Pick<DecisionRecord, "quorum" | "target">> {
  if (code === "quorum_not_met" && state.stage === 5 && state.audiencePolicy) {
    const q = quorumState(state.audiencePolicy, state.audienceDecisions);
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

  if (payload.kind === "mint_requirements") {
    if (state.requirements.length > 0) {
      return refused(state, payload, principalId, "requirements_already_minted");
    }
    const counts: Partial<Record<RequirementKind, number>> = {};
    const requirements: RequirementEntry[] = payload.items.map((item) => {
      const n = (counts[item.kind] ?? 0) + 1;
      counts[item.kind] = n;
      return { id: `${item.kind}-${String(n)}`, kind: item.kind, text: item.text };
    });
    const record: DecisionRecord = {
      decisionId: payload.decisionId,
      kind: "mint_requirements",
      stage: payload.stage,
      accepted: true,
      principalId,
      at: payload.at,
    };
    return { ...state, requirements, decisions: [...state.decisions, record] };
  }

  if (payload.kind === "audience") {
    const audienceDecisions: Record<string, AudienceVote> = {
      ...state.audienceDecisions,
      [payload.audience]: {
        audience: payload.audience,
        decision: payload.decision,
        note: payload.note ?? "",
        principalId,
        at: payload.at,
        decisionId: payload.decisionId,
      },
    };
    const record: DecisionRecord = {
      decisionId: payload.decisionId,
      kind: "audience",
      stage: payload.stage,
      accepted: true,
      principalId,
      at: payload.at,
      audience: payload.audience,
      outcome: payload.decision,
      ...(payload.note ? { note: payload.note } : {}),
    };
    return { ...state, audienceDecisions, decisions: [...state.decisions, record] };
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
      audiencePolicy: payload.policy ?? state.audiencePolicy,
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
      if (code) return refused(state, payload, principalId, code, refusalExtra(state, code, payload.evidence));
    }

    const approvedReviews: Record<StageNumber, ReviewState | undefined> = {
      ...state.reviews,
      [state.stage]: { ...review, status: "approved" },
    };
    const quorum = state.stage === 5 && state.audiencePolicy ? quorumState(state.audiencePolicy, state.audienceDecisions) : null;
    const freeze: Freeze | null =
      state.stage === 7 && isStage7Evidence(payload.evidence)
        ? { target: payload.evidence.target, frozen: payload.evidence.frozen, stack: payload.evidence.stack, decisionId: payload.decisionId }
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
  // Requirement ids are stage 6's: a send-back that reopens stage 6 or
  // earlier can change the approved document they were minted from, so the
  // ids are cleared too -- `mint_requirements` runs again before the
  // Architect's next draft.
  const requirements = targetStage <= 6 ? [] : state.requirements;
  // A send-back that reopens stage 5 or earlier means new packages get
  // written; the votes and the policy they were checked against are stale
  // -- the next stage-5 `open_review` captures a fresh policy and
  // stakeholders vote again.
  const audiencePolicy = targetStage <= 5 ? null : state.audiencePolicy;
  const audienceDecisions = targetStage <= 5 ? {} : state.audienceDecisions;
  return { ...state, stage: targetStage, reviews, decisions: [...state.decisions, record], freeze, requirements, audiencePolicy, audienceDecisions };
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
    requirements: [],
    audiencePolicy: null,
    audienceDecisions: {},
  };
}
