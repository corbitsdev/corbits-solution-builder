import { action, awaitSignal, defineWorkflow, loop } from "@intx/workflow";
import { projectWorkflowLoopCarry, projectWorkflowLoopWhile } from "./loops.js";

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

/**
 * ONE top-level loop. Body: awaitSignal -> action. `carry` is the whole
 * ProjectState, threaded as the body's next `trigger.payload`; `while` reads
 * the same state off the iteration's output. No sleep, onTrigger, child
 * workflow, or sibling loop lives in the body.
 */
export const projectWorkflow = defineWorkflow({
  id: "sb-project-loop-driven",
  trigger: { type: "manual" },
  steps: {
    init: action({ handler: "initProject", input: { from: "trigger.payload" } }),
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
      after: ["init"],
    }),
    exhausted: action({ handler: "recordExhausted", input: { from: "steps.rework.output" }, after: ["rework"] }),
  },
});
