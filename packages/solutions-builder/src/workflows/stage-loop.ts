/**
 * The per-stage workflow — BUILD_PLAN_V3 §9's `stage` definition.
 *
 * A stage is a loop, and it was a loop written in host code: draft, ask, answer,
 * ask again, revise, submit. §9 says that loop belongs to a seeded native
 * workflow, and §7 says the ledger is the only state machine, so this is
 * generated from the ledger too. What the host does inside an iteration —
 * calling a specialist, writing an artifact, recording a question — stays an
 * effect. What can *end* an iteration is a signal, and the signals are exactly
 * the ledger's commands out of `in_progress`.
 *
 * The loop is bounded because an unbounded one is a way to spend somebody's
 * money forever. Exhausting it does not fail the stage: it routes to the same
 * gate a person would have reached anyway, so the work is still theirs to
 * approve or send back.
 */
import {
  awaitSignal,
  defineWorkflow,
  loop,
  type WorkflowDefinition,
} from "@intx/workflow";
import { LEDGER, type Command, type Stage } from "../ledger.js";

export const STAGE_WORKFLOW_ID = "solutions-builder.stage";

/** How many drafts one stage may produce before a human is asked to look. */
export const MAX_REVISIONS = 24;

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

export function stageSignal(command: Command): string {
  return `${STAGE_WORKFLOW_ID}.${command}`;
}

/**
 * One iteration: the specialist has drafted, and the workflow waits to hear
 * what the person did about it. Every exit the ledger allows is a signal the
 * iteration accepts, so the workflow can never be in a state the guard would
 * refuse.
 */
function iteration(stage: Stage): WorkflowDefinition {
  const steps: Record<string, unknown> = {};
  for (const command of loopExits(stage)) {
    steps[command.replace(/\./g, "-")] = awaitSignal({
      name: stageSignal(command),
      // No timeout. A stage waits as long as the person takes; a timer here
      // would be an automatic advancement, which §7 forbids.
      drainBehavior: "wait",
    });
  }

  return defineWorkflow({
    id: `${STAGE_WORKFLOW_ID}.iteration.${stage}`,
    triggers: [{ type: "manual" }],
    steps: steps as never,
    state: {
      schema: { projectId: "string", runId: "string" } as never,
    },
  });
}

export function stageDefinition(stage: Stage): WorkflowDefinition {
  return defineWorkflow({
    id: `${STAGE_WORKFLOW_ID}.${stage}`,
    triggers: [{ type: "manual" }],
    steps: {
      revise: loop({
        body: iteration(stage),
        // Carried between iterations: which version is current. The prompt is
        // rebuilt from it each time rather than replayed.
        carry: "$.state.versionId",
        while: "$.state.open",
        maxIterations: MAX_REVISIONS,
        // Not a failure. Exhaustion means this has been drafted many times
        // without anyone submitting it, and the answer to that is a person,
        // not an error.
        onExhausted: "gate",
        drainBehavior: "wait",
      }),
      gate: awaitSignal({
        name: stageSignal("stage.approve"),
        drainBehavior: "wait",
        after: ["revise"],
      }),
    } as never,
    state: {
      schema: {
        projectId: "string",
        runId: "string",
        stage: "number",
        versionId: "string",
        open: "boolean",
      } as never,
    },
  });
}
