/**
 * The transition guard — the sole enforcement point for the ledger in `./ledger`.
 *
 * Every state change in the product goes through `evaluate`. It is deliberately
 * pure: it takes the current run and the command, and returns either the ledger
 * row that permits the change or a typed refusal. It lives in the app package,
 * not the hub, so nothing about it depends on a database or a provider — the
 * lifecycle workflow can call it directly, ahead of a transition, the same way
 * `apps/hub/src/engine.ts` does today.
 *
 * Two things this file exists to make impossible:
 *   - approving a version other than the one that was reviewed;
 *   - a second state machine, because there is no other place a run state moves.
 */
import {
  FORBIDDEN,
  LEDGER,
  isTerminal,
  type Authority,
  type Command,
  type RunKind,
  type RunState,
  type Stage,
  type Transition,
} from "./ledger.js";

export type RunView = {
  readonly id: string;
  readonly kind: RunKind;
  readonly stage: Stage;
  readonly state: RunState;
  readonly originId: string;
  readonly routeTargetStage: number | null;
  readonly costApprovalVersionId: string | null;
  /** Set only when a worker returned a checkpoint it advertises as resumable. */
  readonly checkpointRef: string | null;
};

export type GuardContext = {
  /** Authorities the actor actually holds on this project. */
  readonly actorAuthorities: readonly Authority[];
  /** Set when the command names a backtrack or route target. */
  readonly targetStage?: Stage;
  /** True when a frozen packet already exists for this run source. */
  readonly frozenPacketExists?: boolean;
  /** Stage-5 quorum, read from recorded audience decisions. */
  readonly audience?: {
    readonly required: number;
    readonly proceeded: number;
    readonly blocked: number;
  };
  /** For build.answer: the origin the waiting request came from. */
  readonly waitingRequestOriginId?: string;
  /** For build.resume: whether the worker advertises checkpoint resume. */
  readonly checkpointResumeVerified?: boolean;
  /**
   * Per version reviewed: whether the hash the actor named still matches the
   * stored bytes. A single `false` means the draft moved under the reviewer.
   */
  readonly versionHashesMatch?: boolean;
};

export const REFUSALS = [
  "unknown_command",
  "wrong_state",
  "wrong_kind",
  "terminal_run",
  "not_authorized",
  "forbidden",
  "stale_version",
  "quorum_not_met",
  "invalid_route",
  "missing_cost_approval",
  "origin_mismatch",
  "checkpoint_unavailable",
] as const;
export type RefusalCode = (typeof REFUSALS)[number];

export type GuardResult =
  | { readonly ok: true; readonly transition: Transition; readonly toStage: Stage }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string };

function refuse(code: RefusalCode, message: string): GuardResult {
  return { ok: false, code, message };
}

/** Which stage the run lands on. The ledger says the state; this says the number. */
function resolveTargetStage(
  transition: Transition,
  run: RunView,
  context: GuardContext,
): Stage | RefusalCode {
  switch (transition.id) {
    case "stage.approve":
      return (run.stage + 1) as Stage;
    case "stage.reject":
    case "stage.revise":
    case "stage.route_back":
    case "build.route_material_change.running":
    case "build.route_material_change.waiting":
    case "delivery.reject":
    case "delivery.revise": {
      const target = context.targetStage;
      if (target === undefined || target > run.stage) return "invalid_route";
      return target;
    }
    case "stage.select_route": {
      const recorded = run.routeTargetStage;
      if (recorded === null) return "invalid_route";
      // The backtrack already recorded the target; the command cannot pick a
      // different one, which is what stops a reject from being re-aimed later.
      if (context.targetStage !== undefined && context.targetStage !== recorded) {
        return "invalid_route";
      }
      return recorded as Stage;
    }
    case "build.freeze":
      return 8;
    case "build.accept_evidence":
      return 9;
    default:
      return run.stage;
  }
}

/**
 * The ledger row for a command that begins a run rather than moving one.
 *
 * `evaluate` only considers rows with a `from` state, because everything it
 * decides is about leaving one. `project.create` has no state to leave, so it
 * would otherwise be the one mutating command with no ledger row behind it —
 * the caller reads its authority, kind and opening state from here instead of
 * restating them.
 */
export function origin(command: Command): Transition | null {
  return LEDGER.find((row) => row.command === command && row.from === null) ?? null;
}

export function evaluate(
  command: Command,
  run: RunView,
  context: GuardContext,
): GuardResult {
  const candidates = LEDGER.filter((row) => row.command === command && row.from !== null);
  if (candidates.length === 0) return refuse("unknown_command", `No ledger row for ${command}.`);

  // A terminal run never reactivates — unless the ledger has an explicit row
  // starting from that exact terminal state for this exact command. Today that
  // is `project.archive` from `delivered`, and `build.start_attempt` from a
  // terminal build run, both of which create a new record rather than moving
  // the terminal one.
  const startsFromThisTerminal = candidates.some(
    (row) => row.from?.kind === run.kind && row.from?.state === run.state,
  );
  if (isTerminal(run.state) && !startsFromThisTerminal) {
    // A second freeze against an already-frozen run is the interlock, so it
    // gets the interlock's own explanation rather than the generic one.
    if (command === "build.freeze" && run.state === "approved_frozen") {
      const rule = FORBIDDEN.find((entry) => entry.command === "build.freeze");
      return refuse("forbidden", rule?.reason ?? "A frozen packet already exists.");
    }
    return refuse(
      "terminal_run",
      `Run ${run.id} is ${run.state}; terminal runs never reactivate.`,
    );
  }

  const kindMatched = candidates.filter((row) => row.from?.kind === run.kind);
  if (kindMatched.length === 0) {
    return refuse("wrong_kind", `${command} does not apply to a ${run.kind} run.`);
  }

  const transition = kindMatched.find((row) => row.from?.state === run.state);
  if (!transition) {
    return refuse(
      "wrong_state",
      `${command} is not available from ${run.kind}/${run.state}.`,
    );
  }

  if (transition.stages && !transition.stages.includes(run.stage)) {
    // Stage 7 is the case that matters: `stage.approve` is listed for stages
    // 1-6, so a stage-7 approval lands here rather than skipping cost approval.
    return refuse(
      "forbidden",
      `${command} does not apply at stage ${run.stage}. ` +
        (command === "stage.approve" && run.stage === 7
          ? "Stage 7 leaves waiting_approval through cost.approve, then build.freeze."
          : `It applies at stage ${transition.stages.join(", ")}.`),
    );
  }

  const permitted = transition.authority.some((authority) =>
    context.actorAuthorities.includes(authority),
  );
  if (!permitted) {
    return refuse(
      "not_authorized",
      `${command} requires ${transition.authority.join(" or ")}.`,
    );
  }

  if (context.versionHashesMatch === false) {
    return refuse(
      "stale_version",
      "The reviewed version no longer matches the stored bytes. " +
        "Re-open the exact version and decide again.",
    );
  }

  if (command === "build.freeze") {
    if (context.frozenPacketExists) {
      const rule = FORBIDDEN.find((entry) => entry.command === "build.freeze");
      return refuse("forbidden", rule?.reason ?? "A frozen packet already exists.");
    }
    if (run.costApprovalVersionId === null) {
      return refuse(
        "missing_cost_approval",
        "build.freeze requires cost.approve on the same run origin first.",
      );
    }
  }

  if (command === "stage.approve" && run.stage === 5) {
    const audience = context.audience;
    if (!audience) {
      return refuse("quorum_not_met", "Stage 5 requires recorded audience decisions.");
    }
    if (audience.blocked > 0) {
      return refuse(
        "quorum_not_met",
        `${audience.blocked} audience decision(s) reject or revise; that blocks approval.`,
      );
    }
    if (audience.proceeded < audience.required) {
      return refuse(
        "quorum_not_met",
        `Quorum is ${audience.required}; ${audience.proceeded} audience(s) have decided proceed.`,
      );
    }
  }

  if (command === "build.answer" && context.waitingRequestOriginId !== run.originId) {
    const rule = FORBIDDEN.find((entry) => entry.command === "build.answer");
    return refuse("origin_mismatch", rule?.reason ?? "The waiting request has another origin.");
  }

  if (command === "build.resume" && context.checkpointResumeVerified !== true) {
    return refuse(
      "checkpoint_unavailable",
      "No verified checkpoint resume for this worker. " +
        "Start a new attempt from the immutable packet instead.",
    );
  }

  const toStage = resolveTargetStage(transition, run, context);
  if (typeof toStage === "string") {
    return refuse(toStage, "The command names a stage this route does not allow.");
  }

  return { ok: true, transition, toStage };
}

/**
 * `audience.decide` is record-only, so it never reaches `evaluate`'s transition
 * path. It still needs the same authority and freshness checks.
 */
export function evaluateAudienceDecision(
  run: RunView,
  context: GuardContext,
): GuardResult {
  const transition = LEDGER.find((row) => row.id === "audience.decide");
  if (!transition) return refuse("unknown_command", "audience.decide is missing from the ledger.");
  if (run.stage !== 5) {
    return refuse("forbidden", "Audience decisions are recorded at stage 5 only.");
  }
  if (run.state !== "waiting_approval") {
    return refuse("wrong_state", `Stage 5 is ${run.state}, not awaiting audience review.`);
  }
  if (!context.actorAuthorities.includes("audience_member")) {
    return refuse("not_authorized", "Only a named audience for this project may decide.");
  }
  if (context.versionHashesMatch === false) {
    return refuse("stale_version", "The audience package changed since it was opened.");
  }
  return { ok: true, transition, toStage: 5 };
}
