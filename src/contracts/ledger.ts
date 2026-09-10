/**
 * The sole transition ledger — BUILD_PLAN_V3 section 7.
 *
 * This file is the single machine-readable contract. Command guards, workflow
 * definitions, UI labels and transition tests all consume it. A second
 * handwritten state machine anywhere in the tree is a defect;
 * `scripts/check-ledger.ts` is what makes that claim checkable.
 */

export const RUN_KINDS = ["stage", "build"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** Stage numbers are 1-9 and fixed. Templates fill slots, never reorder gates. */
export const STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_TITLES: Readonly<Record<Stage, string>> = {
  1: "Problem discovery",
  2: "Solution shape",
  3: "Solution proposal",
  4: "GUI design",
  5: "Concept approval",
  6: "Build plan",
  7: "Cost approval",
  8: "Build and test",
  9: "Deliver",
};

/**
 * Run states. `stage` runs and `build` runs share this union but never share a
 * value: a state belongs to exactly one kind, which is what lets the guard
 * reject mismatched routing without a second lookup.
 */
export const STAGE_STATES = [
  "in_progress",
  "waiting_approval",
  "cost_approved",
  "approved_frozen",
  "backtracked",
  "failed",
  "cancelled",
  "delivery_review",
  "delivered",
  "archived",
  "deleted",
] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const BUILD_STATES = [
  "queued",
  "running",
  "waiting_human",
  "failed",
  "cancelled",
  "interrupted",
  "evidence_accepted",
] as const;
export type BuildState = (typeof BUILD_STATES)[number];

export type RunState = StageState | BuildState;

/** States no command may leave. Terminal build runs never reactivate. */
export const TERMINAL_STATES = [
  "approved_frozen",
  "failed",
  "cancelled",
  "delivered",
  "archived",
  "deleted",
  "evidence_accepted",
] as const satisfies readonly RunState[];

export const COMMANDS = [
  "project.create",
  "stage.submit",
  "stage.approve",
  "stage.reject",
  "stage.revise",
  "stage.route_back",
  "stage.select_route",
  "stage.fail",
  "stage.cancel",
  "stage.retry",
  "audience.decide",
  "cost.approve",
  "build.freeze",
  "build.start_attempt",
  "build.wait_for_human",
  "build.answer",
  "build.route_material_change",
  "build.fail",
  "build.cancel",
  "build.interrupt",
  "build.resume",
  "build.accept_evidence",
  "delivery.accept",
  "delivery.reject",
  "delivery.revise",
  "project.archive",
  "project.delete",
] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * Authority required to issue a command. Agents hold none of these: a model
 * drafts, a human decides. `system` means the host itself may raise it (a
 * verified worker request), never a model and never to cross a gate.
 */
export const AUTHORITIES = [
  "project_owner",
  "budget_approver",
  "technical_approver",
  "audience_member",
  "builder_operator",
  "delivery_recipient",
  "system",
] as const;
export type Authority = (typeof AUTHORITIES)[number];

export type Transition = {
  /** Stable id; audit rows and tests reference this, not a row index. */
  readonly id: string;
  readonly command: Command;
  readonly from: { readonly kind: RunKind; readonly state: RunState } | null;
  /**
   * `null` for record-only commands (`audience.decide`) and for commands whose
   * effect is a field on the source run rather than a new state
   * (`cost.approve`). Recorded here so no caller has to special-case them
   * outside the ledger.
   */
  readonly to: { readonly kind: RunKind; readonly state: RunState } | null;
  readonly authority: readonly Authority[];
  /** Preconditions in prose, mirrored one-to-one by `guard.ts`. */
  readonly preconditions: readonly string[];
  /** What durably exists after the command commits. */
  readonly effects: readonly string[];
  /** True when the transition creates a new run rather than moving this one. */
  readonly createsRun: RunKind | null;
  /** Stage restriction, when the row only applies at particular stages. */
  readonly stages: readonly Stage[] | null;
  readonly note?: string;
};

export const LEDGER: readonly Transition[] = [
  {
    id: "project.create",
    command: "project.create",
    from: null,
    to: { kind: "stage", state: "in_progress" },
    authority: ["project_owner"],
    preconditions: ["valid initial policy and workspace scope"],
    effects: ["project", "root branch", "stage run 1"],
    createsRun: "stage",
    stages: [1],
  },
  {
    id: "stage.submit",
    command: "stage.submit",
    from: { kind: "stage", state: "in_progress" },
    to: { kind: "stage", state: "waiting_approval" },
    authority: ["project_owner", "system"],
    preconditions: [
      "draft belongs to the same stage and branch",
      "draft passes boundary validation",
    ],
    effects: ["immutable draft artifact version", "review request"],
    createsRun: null,
    stages: null,
  },
  {
    id: "stage.approve",
    command: "stage.approve",
    from: { kind: "stage", state: "waiting_approval" },
    to: { kind: "stage", state: "in_progress" },
    authority: ["project_owner", "technical_approver"],
    preconditions: [
      "approver names the exact artifact versions under review",
      "stage 5 additionally requires the recorded audience quorum with no reject or revise",
      "stage 6 requires technical approval of completeness and buildability",
    ],
    effects: ["immutable ApprovalRecord", "new stage run at n+1"],
    createsRun: "stage",
    stages: [1, 2, 3, 4, 5, 6],
    note: "Stages 1-6 only. Stage 7 leaves waiting_approval through cost.approve.",
  },
  {
    id: "audience.decide",
    command: "audience.decide",
    from: { kind: "stage", state: "waiting_approval" },
    to: null,
    authority: ["audience_member"],
    preconditions: [
      "stage 5",
      "actor is a named audience for this project",
      "decision names the exact audience package version",
    ],
    effects: ["ApprovalRecord for one audience"],
    createsRun: null,
    stages: [5],
    note: "Record-only. Never transitions; stage.approve reads the quorum.",
  },
  {
    id: "cost.approve",
    command: "cost.approve",
    from: { kind: "stage", state: "waiting_approval" },
    to: { kind: "stage", state: "cost_approved" },
    authority: ["budget_approver"],
    preconditions: [
      "stage 7",
      "exact cost approval version and its plan/design/requirement inputs",
      "actor holds budget authority for this project",
    ],
    effects: ["cost approval recorded on the stage run"],
    createsRun: null,
    stages: [7],
    note: "No stage advance. build.freeze is the transition.",
  },
  {
    id: "build.freeze",
    command: "build.freeze",
    from: { kind: "stage", state: "cost_approved" },
    to: { kind: "build", state: "queued" },
    authority: ["project_owner", "builder_operator"],
    preconditions: [
      "no frozen packet already exists for this run source",
      "the cost approval and the freeze name the same run origin",
      "every packet input names an approved exact version",
    ],
    effects: [
      "stage 7 run becomes terminal approved_frozen",
      "immutable BuildPacket",
      "new build run at stage 8",
    ],
    createsRun: "build",
    stages: [7],
    note: "The interlock: freeze requires cost.approve first. Re-freeze is forbidden.",
  },
  {
    id: "build.start_attempt",
    command: "build.start_attempt",
    from: { kind: "build", state: "queued" },
    to: { kind: "build", state: "running" },
    authority: ["builder_operator", "system"],
    preconditions: [
      "approved immutable packet",
      "compatible authorized worker and placement",
      "scoped credentials and grants",
      "idempotency key and build origin",
    ],
    effects: ["attempt", "worker binding", "compatibility record", "audit", "outbox"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.start_attempt.retry",
    command: "build.start_attempt",
    from: { kind: "build", state: "failed" },
    to: { kind: "build", state: "queued" },
    authority: ["builder_operator"],
    preconditions: ["terminal source run", "unchanged immutable packet"],
    effects: ["new queued build run linked to the unchanged source"],
    createsRun: "build",
    stages: [8],
  },
  {
    id: "build.start_attempt.after_cancel",
    command: "build.start_attempt",
    from: { kind: "build", state: "cancelled" },
    to: { kind: "build", state: "queued" },
    authority: ["builder_operator"],
    preconditions: ["terminal source run", "unchanged immutable packet"],
    effects: ["new queued build run linked to the unchanged source"],
    createsRun: "build",
    stages: [8],
  },
  {
    id: "build.start_attempt.no_checkpoint",
    command: "build.start_attempt",
    from: { kind: "build", state: "interrupted" },
    to: { kind: "build", state: "queued" },
    authority: ["builder_operator"],
    preconditions: [
      "no verified checkpoint resume for this worker",
      "operator explicitly chose to restart from the packet",
    ],
    effects: ["new queued build run from the immutable packet, source unchanged"],
    createsRun: "build",
    stages: [8],
  },
  {
    id: "build.wait_for_human.queued",
    command: "build.wait_for_human",
    from: { kind: "build", state: "queued" },
    to: { kind: "build", state: "waiting_human" },
    authority: ["system"],
    preconditions: ["verified direct worker request"],
    effects: ["durable request with policy, actor and deadline"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.wait_for_human.running",
    command: "build.wait_for_human",
    from: { kind: "build", state: "running" },
    to: { kind: "build", state: "waiting_human" },
    authority: ["system"],
    preconditions: ["verified direct worker request"],
    effects: ["durable request with policy, actor and deadline"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.answer",
    command: "build.answer",
    from: { kind: "build", state: "waiting_human" },
    to: { kind: "build", state: "running" },
    authority: ["builder_operator", "project_owner"],
    preconditions: [
      "the waiting request originated from a queued attempt of this same run",
      "authorized answer, grant or continue decision",
    ],
    effects: ["immutable decision", "scoped grant reference", "the same attempt resumes"],
    createsRun: null,
    stages: [8],
    note: "Never creates an attempt and never changes origin.",
  },
  {
    id: "build.route_material_change.running",
    command: "build.route_material_change",
    from: { kind: "build", state: "running" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["project_owner", "technical_approver"],
    preconditions: ["confirmed backtrack target stage"],
    effects: ["build run terminalized and retained", "DecisionFlag", "route"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.route_material_change.waiting",
    command: "build.route_material_change",
    from: { kind: "build", state: "waiting_human" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["project_owner", "technical_approver"],
    preconditions: ["confirmed backtrack target stage"],
    effects: ["build run terminalized and retained", "DecisionFlag", "route"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.fail",
    command: "build.fail",
    from: { kind: "build", state: "running" },
    to: { kind: "build", state: "failed" },
    authority: ["system", "builder_operator"],
    preconditions: ["same run origin"],
    effects: ["terminal reason", "retained evidence"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.cancel",
    command: "build.cancel",
    from: { kind: "build", state: "running" },
    to: { kind: "build", state: "cancelled" },
    authority: ["builder_operator", "project_owner"],
    preconditions: ["same run origin"],
    effects: ["terminal reason", "retained evidence"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.interrupt",
    command: "build.interrupt",
    from: { kind: "build", state: "running" },
    to: { kind: "build", state: "interrupted" },
    authority: ["builder_operator", "system"],
    preconditions: ["same run origin"],
    effects: ["terminal for this run", "checkpoint retained where the worker supports one"],
    createsRun: null,
    stages: [8],
  },
  {
    id: "build.resume",
    command: "build.resume",
    from: { kind: "build", state: "interrupted" },
    to: { kind: "build", state: "queued" },
    authority: ["builder_operator"],
    preconditions: ["verified compatible checkpoint resume advertised by the worker"],
    effects: ["new checkpoint-linked queued build run; the source stays interrupted"],
    createsRun: "build",
    stages: [8],
  },
  {
    id: "build.accept_evidence",
    command: "build.accept_evidence",
    from: { kind: "build", state: "running" },
    to: { kind: "stage", state: "delivery_review" },
    authority: ["project_owner", "technical_approver"],
    preconditions: [
      "complete verifier report with no required check failing or unknown",
      "human stage-8 approval of the evidence",
    ],
    effects: [
      "build run terminal with evidence",
      "DeliveryManifest",
      "new stage run at 9",
    ],
    createsRun: "stage",
    stages: [8],
  },
  {
    id: "stage.reject",
    command: "stage.reject",
    from: { kind: "stage", state: "waiting_approval" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["project_owner", "technical_approver", "budget_approver", "audience_member"],
    preconditions: ["reason and a valid earlier target stage"],
    effects: ["DecisionFlag", "supersession", "route"],
    createsRun: null,
    stages: null,
  },
  {
    id: "stage.revise",
    command: "stage.revise",
    from: { kind: "stage", state: "waiting_approval" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["project_owner", "technical_approver", "budget_approver", "audience_member"],
    preconditions: ["reason and a valid target stage"],
    effects: ["DecisionFlag", "supersession", "route"],
    createsRun: null,
    stages: null,
  },
  {
    id: "stage.route_back",
    command: "stage.route_back",
    from: { kind: "stage", state: "waiting_approval" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["project_owner", "technical_approver", "budget_approver"],
    preconditions: ["reason and a valid earlier target stage"],
    effects: ["DecisionFlag", "supersession", "route"],
    createsRun: null,
    stages: null,
  },
  {
    id: "stage.select_route",
    command: "stage.select_route",
    from: { kind: "stage", state: "backtracked" },
    to: { kind: "stage", state: "in_progress" },
    authority: ["project_owner"],
    preconditions: ["valid branch and target stage recorded by the backtrack"],
    effects: ["new stage run at the target, history retained"],
    createsRun: "stage",
    stages: null,
  },
  {
    id: "stage.fail",
    command: "stage.fail",
    from: { kind: "stage", state: "in_progress" },
    to: { kind: "stage", state: "failed" },
    authority: ["system", "project_owner"],
    preconditions: ["same run origin"],
    effects: ["terminal reason", "inputs retained"],
    createsRun: null,
    stages: null,
  },
  {
    id: "stage.cancel",
    command: "stage.cancel",
    from: { kind: "stage", state: "in_progress" },
    to: { kind: "stage", state: "cancelled" },
    authority: ["project_owner"],
    preconditions: ["same run origin"],
    effects: ["terminal reason", "inputs retained"],
    createsRun: null,
    stages: null,
  },
  {
    id: "stage.retry.failed",
    command: "stage.retry",
    from: { kind: "stage", state: "failed" },
    to: { kind: "stage", state: "in_progress" },
    authority: ["project_owner"],
    preconditions: ["terminal stage origin"],
    effects: ["new in_progress attempt linked to the unchanged prior run"],
    createsRun: "stage",
    stages: null,
  },
  {
    id: "stage.retry.cancelled",
    command: "stage.retry",
    from: { kind: "stage", state: "cancelled" },
    to: { kind: "stage", state: "in_progress" },
    authority: ["project_owner"],
    preconditions: ["terminal stage origin"],
    effects: ["new in_progress attempt linked to the unchanged prior run"],
    createsRun: "stage",
    stages: null,
  },
  {
    id: "delivery.accept",
    command: "delivery.accept",
    from: { kind: "stage", state: "delivery_review" },
    to: { kind: "stage", state: "delivered" },
    authority: ["delivery_recipient", "project_owner"],
    preconditions: [
      "exact manifest version and its evidence",
      "actor holds recipient or owner authority",
    ],
    effects: ["immutable delivery approval"],
    createsRun: null,
    stages: [9],
  },
  {
    id: "delivery.reject",
    command: "delivery.reject",
    from: { kind: "stage", state: "delivery_review" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["delivery_recipient", "project_owner"],
    preconditions: ["remediation route to a valid earlier stage"],
    effects: ["rejection record", "exact route"],
    createsRun: null,
    stages: [9],
  },
  {
    id: "delivery.revise",
    command: "delivery.revise",
    from: { kind: "stage", state: "delivery_review" },
    to: { kind: "stage", state: "backtracked" },
    authority: ["delivery_recipient", "project_owner"],
    preconditions: ["remediation route to a valid earlier stage"],
    effects: ["revision record", "exact route"],
    createsRun: null,
    stages: [9],
  },
  {
    id: "project.archive",
    command: "project.archive",
    from: { kind: "stage", state: "delivered" },
    to: { kind: "stage", state: "archived" },
    authority: ["project_owner"],
    preconditions: ["the project reached delivered"],
    effects: ["hidden from active work, lineage retained"],
    createsRun: null,
    stages: [9],
    note: "Delivered-only. Anything that stopped earlier stays visible in its own state.",
  },
];

/** `build.freeze` a second time for the same source is rejected, not queued. */
export const FORBIDDEN: readonly {
  readonly command: Command;
  readonly when: string;
  readonly reason: string;
}[] = [
  {
    command: "build.freeze",
    when: "a frozen packet already exists for the same run source",
    reason:
      "Re-freeze creates a new linked version only through a routed re-approval of stages 6 and 7.",
  },
  {
    command: "stage.approve",
    when: "the run is at stage 7",
    reason: "Stage 7 leaves waiting_approval through cost.approve, then build.freeze.",
  },
  {
    command: "build.answer",
    when: "the waiting request did not originate from a queued attempt of this run",
    reason:
      "build.answer resumes the same queued-origin attempt; it never creates one or changes origin.",
  },
];

/**
 * `project.delete` is deliberately outside `LEDGER`: it acts on a project, not
 * on a run, and project status is a projection of stage runs rather than a
 * transition authority of its own.
 */
export const PROJECT_DELETE = {
  command: "project.delete" as const,
  authority: ["project_owner"] as const,
  preconditions: [
    "authorized retention and legal eligibility",
    "sink eligibility for every referenced artifact",
  ],
  effects: ["tombstone", "sink receipts", "deletion audit"],
};

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}
