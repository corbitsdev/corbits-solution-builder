/**
 * The nine-stage lifecycle, as a native Interchange workflow.
 *
 * Build plan §7 is explicit: "Generate one machine-readable contract from this
 * ledger before production implementation. Native workflow definitions, command
 * guards, UI labels/projections and transition tests consume it." This is the
 * native-workflow consumer. It is **generated** from `contracts/ledger.ts` —
 * not written alongside it — so the workflow Interchange runs and the guard the
 * host enforces cannot drift. `scripts/check-ledger.ts` asserts they agree.
 *
 * Shape: each of the nine stages is a child workflow — the `stage` definition
 * §9 names, which is the draft-and-revise loop ending at that stage's gate.
 * This one owns the order of the nine and nothing else. Inside a stage, the
 * commands that can leave a state become the signals a step accepts, which is
 * a direct reading of the ledger rather than a re-modelling of it: a gate in
 * the product is a gate in the workflow.
 */
import {
  childWorkflow,
  defineWorkflow,
  type WorkflowDefinition,
} from "@intx/workflow";
import { stageDefinition } from "./stage-loop.js";
import {
  LEDGER,
  STAGES,
  type Command,
  type Stage,
} from "../../contracts/ledger.js";

export const PROJECT_LIFECYCLE_ID = "solutions-builder.project-lifecycle";

/** The step id for a stage. Stable, and referenced by the run projection. */
export function stageStepId(stage: Stage): string {
  return `stage-${stage}`;
}

/**
 * The commands that can leave a given stage's gate, straight from the ledger.
 * A command with no `stages` restriction applies at every stage.
 */
export function commandsAtStage(stage: Stage): Command[] {
  const commands = LEDGER.filter(
    (row) => row.from !== null && (row.stages === null || row.stages.includes(stage)),
  ).map((row) => row.command);
  return [...new Set(commands)];
}

/**
 * Builds the definition Interchange deploys.
 *
 * Every stage waits for a human. Nothing advances on a timer, and no step
 * carries an agent: a specialist drafting is an effect the host performs
 * *inside* a stage, never a transition. That is what keeps "models draft,
 * humans decide" true at the workflow layer and not only in the UI.
 */
export function projectLifecycleDefinition(): WorkflowDefinition {
  const steps: Record<string, unknown> = {};
  const stepOrder: string[] = [];

  for (const stage of STAGES) {
    const id = stageStepId(stage);
    stepOrder.push(id);
    // Each stage is a child workflow — its own bounded draft-and-revise loop
    // ending at its own gate — rather than a single signal. §9 puts that loop
    // in the `stage` definition, and the lifecycle's job is the order of the
    // nine, not what happens inside one.
    steps[id] = childWorkflow({
      definition: stageDefinition(stage),
      // The child owns a human gate, so cancelling it on drain would discard a
      // decision somebody is in the middle of making.
      drainBehavior: "wait",
      ...(stepOrder.length > 1 ? { after: [stepOrder[stepOrder.length - 2]!] } : {}),
    });
  }

  return defineWorkflow({
    id: PROJECT_LIFECYCLE_ID,
    // Projects are started by a person, never by a schedule or an inbound mail.
    triggers: [{ type: "manual" }],
    steps: steps as never,
    state: {
      schema: {
        projectId: "string",
        branchId: "string",
        stage: "number",
        state: "string",
      } as never,
    },
  });
}
