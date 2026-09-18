/**
 * The per-stage shape of the lifecycle — BUILD_PLAN_V3 §9's `stage`.
 *
 * A stage is a loop, and it was a loop written in host code: draft, ask, answer,
 * ask again, revise, submit. §9 says that loop belongs to a native workflow, and
 * §7 says the ledger is the only state machine, so this is generated from the
 * ledger too. What the host does inside an iteration — calling a specialist,
 * writing an artifact, recording a question — stays an effect. What ends an
 * iteration is a signal carrying the ledger command a person issued.
 *
 * Every gate lives on the deployment's top-level run, because that is the only
 * run the hub lets a caller signal: a loop relays a named signal into the
 * iteration that awaits it, a child workflow does not. So each stage is two
 * top-level steps, a bounded revise loop and an approval gate, and the signal
 * names carry the stage so the nine stages never share a name on one run.
 *
 * The loop is bounded because an unbounded one is a way to spend somebody's
 * money forever. Exhausting it does not fail the stage: it routes to the same
 * gate a person would have reached anyway, so the work is still theirs to
 * approve or send back.
 */
import {
  action,
  awaitSignal,
  defineWorkflow,
  loop,
  type WorkflowDefinition,
} from "@intx/workflow";
import { LEDGER, type Command, type Stage } from "../ledger.js";
import { panelPrincipals } from "../kit.js";

export const STAGE_WORKFLOW_ID = "solutions-builder.stage";

/** How many drafts one stage may produce before a human is asked to look. */
export const MAX_REVISIONS = 24;

/** The one step inside an iteration: the round waits to hear what the person did. */
export const ROUND_STEP_ID = "round";

/** The step that runs the stage's specialist once a round asks for a draft. */
export const DRAFT_STEP_ID = "draft";
/**
 * Stage 9's own draft-equivalent step id. It cannot share `DRAFT_STEP_ID`:
 * the deployed workflow's capability walk fails closed when one leaf step id
 * recurs across loop bodies with different grants, and stage 9's specialist
 * alone carries the delivery-status tool while every other drafted stage's
 * "draft" step carries none.
 */
export const DELIVERY_STEP_ID = "delivery-check";
/** The one stage whose drafting step is `DELIVERY_STEP_ID`, not `DRAFT_STEP_ID`. */
export const DELIVERY_STAGE: Stage = 9;
/**
 * Stage 6's first step: the requirements document the plan is written
 * against. It runs in a round of its own, ahead of the plan, because the
 * architect's prompt has to carry the requirements as an input and the host
 * only has them once this step has answered.
 */
export const REQUIREMENTS_STEP_ID = "requirements";
/** The gate after the round: does this round's command ask for a draft? */
export const DECIDE_STEP_ID = "decide";
/** The gate's empty branch — pure data, taken when there is nothing to draft. */
export const NO_DRAFT_STEP_ID = "no-draft";
/** The advisory brief-evaluator step, stage 1 only. */
export const EVALUATE_STEP_ID = "evaluate";
/** The one stage whose draft is followed by the brief evaluator. */
export const EVALUATED_STAGE: Stage = 1;
/** The awaiter inside a gate loop: the person sends the command. */
export const GATE_WAIT_STEP_ID = "wait";
/** The action inside a gate loop: the ledger guard admits or refuses. */
export const ADMIT_STEP_ID = "admit";

/**
 * What the admit action reads, in override order: the tally the loop carried
 * from the last iteration, the delivered intent, then the gate's own literals
 * last — the stage and kind of gate are the workflow's, never the client's.
 */
export function admitInput(
  waitStepId: string,
  literal: { readonly stage: Stage; readonly gate: "gate" | "exhausted" | "evidence"; readonly quorum?: number },
): Record<string, unknown> {
  return {
    merge: [
      { project: { from: "trigger.payload" }, fields: ["audience"] },
      { from: `steps.${waitStepId}.output` },
      { literal },
    ],
  };
}
/**
 * How long one drafting agent step may run before the runtime fails it.
 * Matches `DEFAULT_TIMEOUT_MS` in `apps/hub/src/inference.ts`, the timeout
 * the host itself uses for an inference call of this shape.
 */
export const DRAFT_STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** The step id for one of stage 6's panel principals reviewing the draft. */
export function panelStepId(specialty: string): string {
  return `review-${specialty}`;
}

/** The step id for one of stage 5's per-audience packaging steps. */
export function audienceStepId(index: number): string {
  return `package-${index}`;
}

/** A panel principal's short specialty id, read off its seeded role id. */
function panelSpecialty(roleId: string): string {
  const specialty = roleId.replace(/^senior-engineer-/, "");
  if (specialty === roleId) throw new Error(`Not a panel principal role: ${roleId}`);
  return specialty;
}

/**
 * The agent step ids a stage contributes to its iteration, in run order —
 * the same order the rendered lifecycle wires them with `after`. Stage 8
 * keeps its own build step outside this shape (see `BUILD_STEP_ID`), and a
 * stage 5 with no audiences contributes none: nothing to package, so the
 * stage stays gates-only.
 */
export function agentStepIds(stage: Stage, audienceCount: number): string[] {
  if (stage === 5) {
    return Array.from({ length: audienceCount }, (_unused, index) => audienceStepId(index));
  }
  if (stage === 6) {
    return [REQUIREMENTS_STEP_ID, DRAFT_STEP_ID, ...panelPrincipals().map((role) => panelStepId(panelSpecialty(role.id)))];
  }
  if (stage === EVALUATED_STAGE) {
    return [DRAFT_STEP_ID, EVALUATE_STEP_ID];
  }
  if (stage === DELIVERY_STAGE) {
    return [DELIVERY_STEP_ID];
  }
  return [DRAFT_STEP_ID];
}

/**
 * How many of a stage's agent steps, from the first, sit behind a gate of
 * their own that reads the round's "wanted" flag for that step. Stage 5's
 * packages all do, since a round may write one stakeholder's again and leave
 * the rest. Stage 6's requirements and plan do, since the requirements are
 * written in a round of their own and the plan in the next; the panel's
 * reviews follow the plan and are skipped with it.
 */
export function gatedStepCount(stage: Stage, audienceCount: number): number {
  if (stage === 5) return audienceCount;
  if (stage === 6) return 2;
  return 0;
}

/**
 * Commands that leave `stage.in_progress` at this stage, from the ledger.
 *
 * `stage.submit` ends the loop; the rest are the ways a stage stops without
 * being submitted. Read rather than listed, so a new row in the ledger appears
 * here without anyone remembering to add it.
 */
export function loopExits(stage: Stage): Command[] {
  const commands = LEDGER.filter(
    (row) =>
      row.from?.kind === "stage" &&
      row.from.state === "in_progress" &&
      (row.stages === null || row.stages.includes(stage)),
  ).map((row) => row.command);
  return [...new Set(commands)];
}

/**
 * Commands that keep a stage open: the loop continues after one of these,
 * and ends after anything else. Read from the ledger: a stage command that
 * lands back in `in_progress`, or a build command that stays inside the
 * build (stage 8 is one build run with many rounds: attempts, questions,
 * answers, failures).
 */
export function continuingCommands(): Command[] {
  const commands = LEDGER.filter(
    (row) =>
      (row.from?.kind === "stage" &&
        row.from.state === "in_progress" &&
        row.to?.kind === "stage" &&
        row.to.state === "in_progress") ||
      (row.from?.kind === "build" && row.to?.kind === "build"),
  ).map((row) => row.command);
  return [...new Set(commands)];
}

/** The step inside a stage 8 round that runs the build agent under the sidecar. */
export const BUILD_STEP_ID = "build";
/** How long one build attempt may run before the runtime fails the step. */
export const BUILD_STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** The awaiter after the build agent: accept or fail the attempt's evidence. */
export const EVIDENCE_STEP_ID = "evidence";
/** The admit action that follows the evidence awaiter, naming `admitGate`. */
export const EVIDENCE_ADMIT_STEP_ID = "admit-evidence";
/** The stage whose rounds run the builder; a run is never driven through it. */
const BUILD_STAGE: Stage = 8;

/**
 * Whether a command is a round of its stage rather than the gate out of it.
 * A stage command out of `in_progress` is a round; so is every build command
 * that stays inside the build, since stage 8 is one build run with many
 * rounds and only the evidence hand-off leaves it.
 */
function isRoundCommand(command: Command): boolean {
  return LEDGER.some(
    (row) =>
      row.command === command &&
      ((row.from?.kind === "stage" && row.from.state === "in_progress") ||
        (row.from?.kind === "build" && row.to?.kind === "build")),
  );
}

/** Accept and fail park after the build agent, not on the round or gate-8. */
function isEvidenceCommand(command: Command): boolean {
  return command === "build.accept_evidence" || command === "build.fail";
}

/** The signal a stage's revise loop consumes once per iteration. */
export function roundSignal(stage: Stage): string {
  return `${STAGE_WORKFLOW_ID}.${stage}.round`;
}

/** The signal a stage's approval gate consumes. */
export function approveSignal(stage: Stage): string {
  return `${STAGE_WORKFLOW_ID}.${stage}.approve`;
}

/**
 * The signal the exhaustion gate consumes. A distinct name, because the
 * definition validator allows one live awaiter per name and cannot see that
 * the two gates are never live together.
 */
export function exhaustedSignal(stage: Stage): string {
  return `${STAGE_WORKFLOW_ID}.${stage}.approve-after-exhaustion`;
}

/** The signal the evidence park after the build agent consumes. */
export function evidenceSignal(stage: Stage): string {
  return `${STAGE_WORKFLOW_ID}.${stage}.evidence`;
}

export type StageSignal = {
  readonly name: string;
  readonly payload: { readonly command: Command; readonly draft: boolean };
};

/**
 * The signal a ledger command lands as. A round command ends the current
 * round; accept/fail resolve the evidence park after the build agent; every
 * other stage command resolves the gate. The command rides in the payload so
 * the loop's own functions can read it; `draft` is what the iteration's
 * `decide` gate reads to tell a drafting round from any other command that
 * also happens to keep the stage open.
 */
export function stageSignal(
  stage: Stage,
  command: Command,
  gate: "gate" | "exhausted" = "gate",
): StageSignal {
  const name = isEvidenceCommand(command)
    ? evidenceSignal(stage)
    : isRoundCommand(command)
      ? roundSignal(stage)
      : gate === "gate"
        ? approveSignal(stage)
        : exhaustedSignal(stage);
  return { name, payload: { command, draft: command === "stage.draft" } };
}

/**
 * The evidence park: wait for accept/fail, then admit. `after` is the build
 * agent when an offering rendered one; the in-process, gates-only iteration
 * has no such park.
 */
export function evidenceGate(after: readonly string[]): Record<string, unknown> {
  return {
    [EVIDENCE_STEP_ID]: awaitSignal({
      name: evidenceSignal(BUILD_STAGE),
      drainBehavior: "wait",
      after: [...after],
    }),
    [EVIDENCE_ADMIT_STEP_ID]: action({
      handler: "admitGate",
      input: admitInput(EVIDENCE_STEP_ID, { stage: BUILD_STAGE, gate: "evidence" }),
      drainBehavior: "wait",
      after: [EVIDENCE_STEP_ID],
    }),
  };
}

// --- Following the ledger --------------------------------------------------

/** Where a run is parked, in the ledger's terms: a stage's round, or the gate out of it. */
export type RunPosition = { readonly stage: Stage; readonly at: "round" | "gate" };

/** The stage a signal name this module issued belongs to, or null for any other name. */
export function stageOfSignal(signalName: string): Stage | null {
  const match = new RegExp(`^${STAGE_WORKFLOW_ID.replace(/\./g, "\\.")}\\.([1-9])\\.`).exec(signalName);
  return match ? (Number(match[1]) as Stage) : null;
}

/** The position a parked signal name stands for, or null for a name this module never issued. */
export function positionOfSignal(stage: Stage, signalName: string): RunPosition | null {
  if (signalName === roundSignal(stage) || signalName === evidenceSignal(stage)) return { stage, at: "round" };
  if (signalName === approveSignal(stage) || signalName === exhaustedSignal(stage)) return { stage, at: "gate" };
  return null;
}

export function reviseStepId(stage: Stage): string {
  return `revise-${stage}`;
}

export function gateStepId(stage: Stage): string {
  return `gate-${stage}`;
}

/**
 * The gate a stage reaches when its loop ran out of revisions. The runtime
 * treats a loop's `onExhausted` as the branch not taken on convergence and
 * prunes it, so it cannot be the same step as the ordinary gate; it is a
 * second gate on the same signal, and the next stage follows either.
 */
export function exhaustedStepId(stage: Stage): string {
  return `exhausted-${stage}`;
}

/** Dead-end park if a gate loop hits its refusal cap. Not a 8091 signal. */
export function gateCapStepId(stage: Stage): string {
  return `gate-cap-${stage}`;
}

export function exhaustedCapStepId(stage: Stage): string {
  return `exhausted-cap-${stage}`;
}

/** The steps a stage ends on; the next stage starts after both. */
export function stageEnds(stage: Stage): string[] {
  return [gateStepId(stage), exhaustedStepId(stage)];
}

/** The stage a top-level step belongs to, or null for a step that is not a stage's. */
export function stageOfStepId(stepId: string): Stage | null {
  const match = /^(?:revise|gate|exhausted)(?:-cap)?-(\d+)/.exec(stepId);
  return match ? (Number(match[1]) as Stage) : null;
}

/**
 * One iteration: the specialist has drafted, and the workflow waits to hear
 * what the person did about it. One gate, so the first command to arrive ends
 * the round; which command it was decides whether the loop goes on.
 */
export function iteration(stage: Stage): WorkflowDefinition {
  return defineWorkflow({
    id: `${STAGE_WORKFLOW_ID}.iteration.${stage}`,
    triggers: [{ type: "manual" }],
    steps: {
      [ROUND_STEP_ID]: awaitSignal({
        name: roundSignal(stage),
        // No timeout. A stage waits as long as the person takes; a timer here
        // would be an automatic advancement, which §7 forbids.
        drainBehavior: "wait",
      }),
    } as never,
    state: {
      schema: { projectId: "string", runId: "string" } as never,
    },
  });
}

/** One gate iteration: wait for the named signal, then admit. `quorum` is stage 5's audience quorum. */
export function gateIteration(stage: Stage, gate: "gate" | "exhausted", quorum?: number): WorkflowDefinition {
  return defineWorkflow({
    id: `${STAGE_WORKFLOW_ID}.admit.${gate}.${stage}`,
    triggers: [{ type: "manual" }],
    steps: {
      [GATE_WAIT_STEP_ID]: awaitSignal({
        name: gate === "gate" ? approveSignal(stage) : exhaustedSignal(stage),
        drainBehavior: "wait",
      }),
      [ADMIT_STEP_ID]: action({
        handler: "admitGate",
        input: admitInput(GATE_WAIT_STEP_ID, { stage, gate, ...(quorum !== undefined ? { quorum } : {}) }),
        drainBehavior: "wait",
        after: [GATE_WAIT_STEP_ID],
      }),
    } as never,
  });
}

/** The top-level steps a stage contributes to the lifecycle: the loop and its two gates. */
export function stageSteps(stage: Stage, after: readonly string[] | null, quorum?: number): Record<string, unknown> {
  return {
    [reviseStepId(stage)]: loop({
      body: iteration(stage),
      // Both refs are export names in the package's loops module
      // (`interchange.loops`), which the deploy renders beside the definition:
      // the loop goes on while the consumed command keeps the stage open, and
      // the last round's payload is carried into the next.
      while: "stillOpen",
      carry: "carryRound",
      maxIterations: MAX_REVISIONS,
      // Not a failure. Exhaustion means this has been drafted many times
      // without anyone submitting it, and the answer to that is a person,
      // not an error.
      onExhausted: exhaustedStepId(stage),
      drainBehavior: "wait",
      ...(after ? { after: [...after] } : {}),
    }),
    [gateStepId(stage)]: loop({
      body: gateIteration(stage, "gate", quorum),
      while: "gateRefused",
      carry: "carryGate",
      maxIterations: MAX_REVISIONS,
      onExhausted: gateCapStepId(stage),
      drainBehavior: "wait",
      after: [reviseStepId(stage)],
    }),
    [exhaustedStepId(stage)]: loop({
      body: gateIteration(stage, "exhausted", quorum),
      while: "gateRefused",
      carry: "carryGate",
      maxIterations: MAX_REVISIONS,
      onExhausted: exhaustedCapStepId(stage),
      drainBehavior: "wait",
      after: [reviseStepId(stage)],
    }),
    [gateCapStepId(stage)]: awaitSignal({
      name: `${STAGE_WORKFLOW_ID}.${stage}.gate-cap`,
      drainBehavior: "wait",
      after: [gateStepId(stage)],
    }),
    [exhaustedCapStepId(stage)]: awaitSignal({
      name: `${STAGE_WORKFLOW_ID}.${stage}.exhausted-cap`,
      drainBehavior: "wait",
      after: [exhaustedStepId(stage)],
    }),
  };
}

