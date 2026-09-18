/**
 * The workflow gate's admit step — the ledger guard, run inside the run.
 *
 * A gate is a `wait` step on a named signal followed by this action. The
 * input is three things merged by the workflow definition, in this order:
 *
 *   1. the tally carried from the previous gate iteration (`audience`);
 *   2. the delivered signal payload — a person's thin intent (`command`,
 *      `runId`, `versions`, `rationale`, `reason`, `targetStage`,
 *      `audienceName`, `decision`) plus the `principalId` the hub stamped;
 *   3. the gate's own literals (`stage`, `gate`, `quorum`), last, so nothing
 *      a client sends can move the gate it is standing at.
 *
 * Authority is not evaluated here. The hub refused the signal unless the
 * principal held `signal:<name>` on the run, and the installer mints that
 * grant from the same ledger rows the guard reads, so a delivered signal is
 * the authority check already passed. Nothing else about the run is read
 * from the client: the run view is built from the gate's literals.
 *
 * A refusal is the step's output, not a run mutation: the gate loop runs
 * again and waits.
 */
import { LEDGER, type Command, type RunState, type Stage, type Transition } from "./ledger.js";
import {
  authoritiesFor,
  evaluate,
  evaluateAudienceDecision,
  type GuardContext,
  type RefusalCode,
  type RunView,
} from "./guard.js";

/**
 * Which awaiter the admit follows: a stage gate, its exhaustion twin, the
 * build's evidence park, the build stage's own round, or the freeze between
 * stage 7's gate and stage 8's round. A round is not a fixed-state gate: the
 * run it stands on moves every time a round command is admitted (queued,
 * running, waiting on a person, interrupted), so it carries its own state
 * forward across iterations instead of reading it from a literal. A freeze is
 * a fixed-state gate (`cost_approved`), but the one fact the guard needs about
 * it — which version was cost-approved — is not a literal the workflow can
 * write ahead of time, so it comes from the delivered intent the same way a
 * route's `targetStage` already does.
 */
export type GateKind = "gate" | "exhausted" | "evidence" | "round" | "freeze";

/**
 * What a build stage's round carries from one admitted command to the next:
 * the state the run actually stands in, the origin a worker question was
 * raised from (so `build.answer` cannot resume a different attempt's
 * question), and the checkpoint a worker advertised on interrupt (so
 * `build.resume` cannot invent one). Never read from the client: only ever
 * written by a prior admission on this same round.
 */
export type BuildStateCarry = {
  readonly state: RunState;
  readonly waitingRequestOriginId: string | null;
  readonly checkpointRef: string | null;
};

const INITIAL_BUILD_STATE: BuildStateCarry = { state: "queued", waitingRequestOriginId: null, checkpointRef: null };

/** Stage 5's recorded audience decisions, carried across gate iterations. */
export type AudienceTally = {
  readonly required: number;
  readonly proceeded: number;
  readonly blocked: number;
  readonly decided: readonly string[];
};

export type AdmitVerdict =
  | {
      readonly refused: false;
      readonly transition: Transition;
      readonly toStage: Stage;
      readonly audience?: AudienceTally;
      readonly buildState?: BuildStateCarry;
    }
  | {
      readonly refused: true;
      readonly code: RefusalCode;
      readonly message: string;
      readonly audience?: AudienceTally;
      readonly buildState?: BuildStateCarry;
    };

/** The ledger state a gate stands at: stage 9 decides on delivered bytes, every other gate on a submitted draft. */
export function gateState(stage: Stage, gate: GateKind): RunView["state"] {
  if (gate === "evidence") return "running";
  return stage === 9 ? "delivery_review" : "waiting_approval";
}

/** The run as the gate knows it: its own stage and state, the intent's run id. */
export function gateRunView(runId: string, stage: Stage, gate: GateKind): RunView {
  return {
    id: runId,
    kind: gate === "evidence" || stage === 8 ? "build" : "stage",
    stage,
    state: gateState(stage, gate),
    originId: runId,
    routeTargetStage: null,
    costApprovalVersionId: null,
    checkpointRef: null,
  };
}

function asStage(value: unknown): Stage | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9 ? (value as Stage) : null;
}

function asGate(value: unknown): GateKind | null {
  return value === "gate" || value === "exhausted" || value === "evidence" || value === "round" || value === "freeze"
    ? value
    : null;
}

function asTally(value: unknown, required: number): AudienceTally {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    required,
    proceeded: typeof rec.proceeded === "number" ? rec.proceeded : 0,
    blocked: typeof rec.blocked === "number" ? rec.blocked : 0,
    decided: Array.isArray(rec.decided) ? rec.decided.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The build stage's carried state, read back off the loop's own last verdict — never the client body. */
function asBuildState(value: unknown): BuildStateCarry {
  if (!value || typeof value !== "object") return INITIAL_BUILD_STATE;
  const rec = value as Record<string, unknown>;
  return {
    state: typeof rec.state === "string" ? (rec.state as RunState) : INITIAL_BUILD_STATE.state,
    waitingRequestOriginId: asOptionalString(rec.waitingRequestOriginId),
    checkpointRef: asOptionalString(rec.checkpointRef),
  };
}

/**
 * The build state the round carries into its next iteration once a command is
 * admitted. `build.wait_for_human` opens a question against this run's own
 * origin; `build.answer` and `build.resume` consume it — the origin check and
 * the checkpoint check are exactly what a stale or foreign resume would fail
 * on the next admission. `build.interrupt` records whatever checkpoint the
 * worker advertised, if any; every other admitted round command starts the
 * next iteration with neither.
 */
function nextBuildState(
  command: Command,
  runId: string,
  prior: BuildStateCarry,
  transition: Transition,
  checkpointRef: unknown,
): BuildStateCarry {
  const state = (transition.to?.state ?? prior.state) as RunState;
  if (command === "build.wait_for_human") {
    return { state, waitingRequestOriginId: runId, checkpointRef: prior.checkpointRef };
  }
  if (command === "build.interrupt") {
    return { state, waitingRequestOriginId: null, checkpointRef: asOptionalString(checkpointRef) };
  }
  if (command === "build.start_attempt" || command === "build.resume") {
    return { state, waitingRequestOriginId: null, checkpointRef: null };
  }
  return { state, waitingRequestOriginId: null, checkpointRef: prior.checkpointRef };
}

function refused(code: RefusalCode, message: string, audience?: AudienceTally, buildState?: BuildStateCarry): AdmitVerdict {
  return { refused: true, code, message, ...(audience ? { audience } : {}), ...(buildState ? { buildState } : {}) };
}

export type AdmitInput = {
  readonly command: Command;
  readonly runId: string;
  readonly stage: Stage;
  readonly gate: GateKind;
  readonly quorum?: number;
  readonly audience?: unknown;
  readonly targetStage?: unknown;
  readonly audienceName?: unknown;
  readonly decision?: unknown;
  /** The build stage's round only: the state carried from the last admitted round command. */
  readonly buildState?: unknown;
  /** The build stage's round only: a checkpoint a worker advertised on `build.interrupt`. */
  readonly checkpointRef?: unknown;
  /** The freeze only: the exact version `cost.approve` recorded, named by the delivered intent. */
  readonly costApprovalVersionId?: unknown;
};

/**
 * Admit a person's intent at the gate the workflow is standing at. Pure:
 * the same input always yields the same verdict, which is what lets the
 * runtime replay it.
 */
export function admit(input: AdmitInput): AdmitVerdict {
  // The freeze between stage 7's gate and stage 8's round: a fixed-state
  // gate (cost_approved, kind stage), but the cost-approval version is the
  // one fact about the run this gate cannot get from a literal, so it is
  // read from the delivered intent, the same trust boundary `targetStage`
  // already crosses for a route. `frozenPacketExists` is never set: this
  // step exists once in the deployed lifecycle and cannot be re-entered
  // after it admits, so a second freeze of the same run is not a case the
  // workflow can reach, unlike the host-effect path it replaces.
  if (input.gate === "freeze") {
    const run: RunView = {
      id: input.runId,
      kind: "stage",
      stage: input.stage,
      state: "cost_approved",
      originId: input.runId,
      routeTargetStage: null,
      costApprovalVersionId: asOptionalString(input.costApprovalVersionId),
      checkpointRef: null,
    };
    const context: GuardContext = { actorAuthorities: authoritiesFor(input.command) };
    const verdict = evaluate(input.command, run, context);
    if (!verdict.ok) return refused(verdict.code, verdict.message);
    return { refused: false, transition: verdict.transition, toStage: verdict.toStage };
  }

  // The build stage's round is not a fixed-state gate: the run it stands on
  // moves with every admitted command, so its state comes from what the loop
  // itself carried forward, never from a literal or the client body.
  if (input.gate === "round") {
    const prior = asBuildState(input.buildState);
    const run: RunView = {
      id: input.runId,
      kind: "build",
      stage: input.stage,
      state: prior.state,
      originId: input.runId,
      routeTargetStage: null,
      costApprovalVersionId: null,
      checkpointRef: prior.checkpointRef,
    };
    const context: GuardContext = {
      actorAuthorities: authoritiesFor(input.command),
      ...(prior.waitingRequestOriginId !== null ? { waitingRequestOriginId: prior.waitingRequestOriginId } : {}),
      checkpointResumeVerified: prior.checkpointRef !== null,
    };
    const verdict = evaluate(input.command, run, context);
    if (!verdict.ok) return refused(verdict.code, verdict.message, undefined, prior);
    return {
      refused: false,
      transition: verdict.transition,
      toStage: verdict.toStage,
      buildState: nextBuildState(input.command, input.runId, prior, verdict.transition, input.checkpointRef),
    };
  }

  const run = gateRunView(input.runId, input.stage, input.gate);
  const tally = input.stage === 5 ? asTally(input.audience, input.quorum ?? 0) : undefined;
  const targetStage = asStage(input.targetStage);
  const context: GuardContext = {
    actorAuthorities: authoritiesFor(input.command),
    ...(targetStage !== null ? { targetStage } : {}),
    ...(tally ? { audience: tally } : {}),
  };

  // An audience's decision is recorded on the gate, not a way through it:
  // the tally grows and the gate waits for the owner's approval.
  if (input.command === "audience.decide") {
    const verdict = evaluateAudienceDecision(run, context);
    if (!verdict.ok) return refused(verdict.code, verdict.message, tally);
    const audienceName = typeof input.audienceName === "string" ? input.audienceName : "";
    if (!tally || audienceName.length === 0) {
      return refused("forbidden", "An audience decision names the audience deciding.", tally);
    }
    if (tally.decided.includes(audienceName)) {
      return refused("forbidden", `${audienceName} has already decided on this review.`, tally);
    }
    const proceed = input.decision === "proceed";
    return refused("recorded", `${audienceName} decided ${proceed ? "proceed" : String(input.decision)}.`, {
      ...tally,
      proceeded: tally.proceeded + (proceed ? 1 : 0),
      blocked: tally.blocked + (proceed ? 0 : 1),
      decided: [...tally.decided, audienceName],
    });
  }

  const verdict = evaluate(input.command, run, context);
  if (!verdict.ok) return refused(verdict.code, verdict.message, tally);
  return { refused: false, transition: verdict.transition, toStage: verdict.toStage, ...(tally ? { audience: tally } : {}) };
}

/**
 * The `interchange.actions` export the gate loop names. Input is the merged
 * selector described above; anything the gate needs and does not find is a
 * refusal, never a guess.
 */
export async function admitGate(input: unknown): Promise<AdmitVerdict> {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const stage = asStage(rec.stage);
  const gate = asGate(rec.gate);
  if (stage === null || gate === null) {
    return refused("wrong_state", "The gate did not say which stage it stands at.");
  }
  const command = LEDGER.some((row) => row.command === rec.command) ? (rec.command as Command) : null;
  if (!command) return refused("unknown_command", "The signal did not name a ledger command.");
  const runId = typeof rec.runId === "string" && rec.runId.length > 0 ? rec.runId : null;
  if (!runId) return refused("unknown_command", "The signal did not name the run it decides on.");
  return admit({
    command,
    runId,
    stage,
    gate,
    ...(typeof rec.quorum === "number" ? { quorum: rec.quorum } : {}),
    audience: rec.audience,
    targetStage: rec.targetStage,
    audienceName: rec.audienceName,
    decision: rec.decision,
    buildState: rec.buildState,
    checkpointRef: rec.checkpointRef,
    costApprovalVersionId: rec.costApprovalVersionId,
  });
}

/**
 * The stage 6 documents a `stage.draft` round may name. Fixed by the ledger's
 * own shape of stage 6, not by anything a project configures, so it needs no
 * deploy-time literal the way stage 5's audience roster does.
 */
const STAGE_6_DOCUMENTS = ["requirements", "plan"] as const;

export type AdmitDraftVerdict =
  | { readonly draft: true }
  | { readonly draft: false; readonly refused: false }
  | { readonly draft: false; readonly refused: true; readonly code: "forbidden"; readonly message: string };

function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/**
 * Admits a stage's round intent, ahead of the specialist steps that would
 * otherwise run on it. Pure, like `admit`: stage 5's audience names and
 * stage 6's document names are the only things a round's own intent can get
 * wrong (everything else — the run, the stage, the authority to signal it at
 * all — the ledger transition and the hub's own grant already cover). A
 * refusal here is not a way the loop stops: `stage.draft` is still what
 * arrived, so the revise loop is still `stillOpen` and simply waits for the
 * next, corrected, round instead of running a specialist on this one.
 */
export function admitDraft(input: {
  readonly stage: Stage;
  readonly draft?: unknown;
  readonly audiences?: unknown;
  readonly documents?: unknown;
  /** Baked in at deploy time from the project's own policy — never the client's. */
  readonly audienceNames?: readonly string[];
}): AdmitDraftVerdict {
  if (input.draft !== true) return { draft: false, refused: false };

  if (input.stage === 5) {
    const requested = asStringArray(input.audiences);
    if (requested) {
      const configured = input.audienceNames ?? [];
      const unknown = requested.filter((name) => !configured.includes(name));
      if (unknown.length > 0) {
        return {
          draft: false,
          refused: true,
          code: "forbidden",
          message: `Stage 5 has no audience called ${unknown.map((name) => JSON.stringify(name)).join(", ")}.`,
        };
      }
      if (configured.length === 0) {
        return {
          draft: false,
          refused: true,
          code: "forbidden",
          message: "No audiences named yet at stage 5: the run is still gathering them.",
        };
      }
    }
  }

  if (input.stage === 6) {
    const requested = asStringArray(input.documents);
    if (requested) {
      const unknown = requested.filter((name) => !(STAGE_6_DOCUMENTS as readonly string[]).includes(name));
      if (unknown.length > 0) {
        return {
          draft: false,
          refused: true,
          code: "forbidden",
          message: `Stage 6 has no document called ${unknown.map((name) => JSON.stringify(name)).join(", ")}.`,
        };
      }
      if (requested.length === 0) {
        return {
          draft: false,
          refused: true,
          code: "forbidden",
          message: "Either name one of the stage 6 documents, or let the draft decide.",
        };
      }
    }
  }

  return { draft: true };
}

/**
 * The `interchange.actions` export the round's admit step names. Input is
 * the round signal's own output merged with the gate's literal (`stage`, the
 * deploy-time `audienceNames`) — see `lifecycle-source.ts`'s `iteration`.
 */
export async function admitDraftGate(input: unknown): Promise<AdmitDraftVerdict> {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const stage = asStage(rec.stage);
  if (stage === null) {
    return { draft: false, refused: true, code: "forbidden", message: "The round did not say which stage it stands at." };
  }
  const audienceNames = asStringArray(rec.audienceNames);
  return admitDraft({
    stage,
    draft: rec.draft,
    audiences: rec.audiences,
    documents: rec.documents,
    ...(audienceNames ? { audienceNames } : {}),
  });
}
