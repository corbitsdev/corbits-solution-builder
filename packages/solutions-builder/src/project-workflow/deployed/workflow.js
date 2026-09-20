// Deployed mirror of packages/solutions-builder/src/project-workflow/workflow.ts,
// re-expressed as plain JS because `interchange.workflow` is imported directly
// by the sidecar with no build step. Kept structurally identical: one
// top-level loop, awaitSignal -> action body, `while`/`carry` shipped via
// `interchange.loops` (this package's loops.js), `applyDecision` bound to a
// SYNTHETIC compiled-in artifact fixture (see actions.js) -- phase 2 proves
// repetition/restart over the real deploy+signal route, not the artifact
// read path.
import { action, awaitSignal, defineWorkflow, loop } from "@intx/workflow";

export const PROJECT_DECISION_SIGNAL = "project.decision";
export const MAX_ITERATIONS = 500;

export default defineWorkflow({
  id: "sb-project-loop-driven-deployed",
  trigger: { type: "manual" },
  steps: {
    init: action({ handler: "initProject", input: { from: "trigger.payload" } }),
    rework: loop({
      body: defineWorkflow({
        id: "sb-project-loop-body-deployed",
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
