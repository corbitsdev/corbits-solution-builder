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
import { LEDGER, type Command, type Stage, type Transition } from "./ledger.js";
import {
  authoritiesFor,
  evaluate,
  evaluateAudienceDecision,
  type GuardContext,
  type RefusalCode,
  type RunView,
} from "./guard.js";

/** Which awaiter the admit follows: a stage gate, its exhaustion twin, or the build's evidence park. */
export type GateKind = "gate" | "exhausted" | "evidence";

/** Stage 5's recorded audience decisions, carried across gate iterations. */
export type AudienceTally = {
  readonly required: number;
  readonly proceeded: number;
  readonly blocked: number;
  readonly decided: readonly string[];
};

export type AdmitVerdict =
  | { readonly refused: false; readonly transition: Transition; readonly toStage: Stage; readonly audience?: AudienceTally }
  | { readonly refused: true; readonly code: RefusalCode; readonly message: string; readonly audience?: AudienceTally };

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
  return value === "gate" || value === "exhausted" || value === "evidence" ? value : null;
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

function refused(code: RefusalCode, message: string, audience?: AudienceTally): AdmitVerdict {
  return { refused: true, code, message, ...(audience ? { audience } : {}) };
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
};

/**
 * Admit a person's intent at the gate the workflow is standing at. Pure:
 * the same input always yields the same verdict, which is what lets the
 * runtime replay it.
 */
export function admit(input: AdmitInput): AdmitVerdict {
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
  });
}
