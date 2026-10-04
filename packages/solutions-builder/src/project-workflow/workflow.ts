import { defineAgent } from "@intx/agent";
import { action, awaitSignal, defineWorkflow, loop, step } from "@intx/workflow";
import { agentById } from "../kit.js";
import { projectWorkflowLoopCarry, projectWorkflowLoopWhile } from "./loops.js";
import { NAMER_SOURCE } from "./namer-source.js";

export { projectWorkflowLoopCarry, projectWorkflowLoopWhile };

export const PROJECT_DECISION_SIGNAL = "project.decision";

/**
 * No hard ceiling on `maxIterations` was found in the platform source: `loop()`
 * (vendor/interchange/packages/workflow/src/definition/primitives.ts:658-661)
 * only requires a positive integer. 500 gives a nine-stage project headroom
 * for roughly 50 decisions per stage (refusals, send-backs, reapprovals)
 * before exhaustion, well past any real review traffic.
 */
export const MAX_ITERATIONS = 500;

export const NAME_STEP_ID = "name";

/** Bounds how long the loop waits on the namer, and so a fresh run's first park. */
const NAME_TIMEOUT_MS = 60_000;

const namerRole = agentById("namer");
if (!namerRole) throw new Error("namer role missing from the kit");

const namerAgent = defineAgent({
  id: namerRole.id,
  systemPrompt: namerRole.system,
  tools: [],
  capabilities: [],
  inference: { sources: [NAMER_SOURCE] },
});

/**
 * ONE top-level loop. Body: awaitSignal -> action. `carry` is the whole
 * ProjectState, threaded as the body's next `trigger.payload`; `while` reads
 * the same state off the iteration's output. No sleep, onTrigger, child
 * workflow, or sibling loop lives in the body.
 *
 * Naming runs before the loop, never beside it: an agent step finishing while the loop is
 * parked leaves its events buffered under the sequence numbers the next
 * decision's `SignalReceived` takes, and the run dies on it (#201). So the
 * loop waits for naming to settle, through both sides of its route: the
 * runtime skips the untaken side, and a dependency on the step alone or on
 * `nameFailed` alone skips the loop whenever that side is not taken (#203).
 */
export const projectWorkflow = defineWorkflow({
  id: "sb-project-loop-driven",
  trigger: { type: "manual" },
  steps: {
    init: action({ handler: "initProject", input: { from: "trigger.payload" } }),
    [NAME_STEP_ID]: step({ agent: namerAgent, input: { from: "trigger.payload" }, onFailure: "nameFailed", timeout: NAME_TIMEOUT_MS }),
    named: action({ handler: "holdState", input: { from: `steps.${NAME_STEP_ID}.output` }, after: [NAME_STEP_ID] }),
    nameFailed: action({ handler: "recordNameFailed", input: { from: `steps.${NAME_STEP_ID}.output` }, after: [NAME_STEP_ID] }),
    rework: loop({
      body: defineWorkflow({
        id: "sb-project-loop-body",
        trigger: { type: "manual" },
        steps: {
          // A body resumed from its log is started without its trigger
          // payload, so the carried state is copied into a step output first:
          // step outputs are rebuilt from the log, `trigger.payload` is not.
          hold: action({ handler: "holdState", input: { from: "trigger.payload" } }),
          wait: awaitSignal({ name: PROJECT_DECISION_SIGNAL, after: ["hold"] }),
          apply: action({
            handler: "applyDecision",
            input: { merge: [{ from: "steps.hold.output" }, { from: "steps.wait.output" }] },
            after: ["wait"],
          }),
        },
      }),
      while: "projectWorkflowLoopWhile",
      carry: "projectWorkflowLoopCarry",
      input: { from: "steps.init.output" },
      maxIterations: MAX_ITERATIONS,
      onExhausted: "exhausted",
      after: ["init", "named", "nameFailed"],
    }),
    exhausted: action({ handler: "recordExhausted", input: { from: "steps.rework.output" }, after: ["rework"] }),
  },
});
