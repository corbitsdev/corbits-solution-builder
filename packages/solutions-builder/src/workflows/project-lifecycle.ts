/**
 * The nine-stage lifecycle, as a native Interchange workflow.
 *
 * Build plan §7 is explicit: "Generate one machine-readable contract from this
 * ledger before production implementation. Native workflow definitions, command
 * guards, UI labels/projections and transition tests consume it." This is the
 * native-workflow consumer. It is **generated** from `ledger.ts` —
 * not written alongside it — so the workflow Interchange runs and the guard the
 * host enforces cannot drift. `scripts/check-ledger.ts` asserts they agree.
 *
 * Shape: each of the nine stages is two top-level steps — the bounded
 * draft-and-revise loop and the approval gate the `stage` definition §9 names.
 * They live on the top-level run rather than in a child workflow because the
 * hub signals only that run and a loop, unlike a child, relays a named signal
 * into the iteration awaiting it. This one owns the order of the nine and
 * nothing else. The commands that can leave a state become the signals a step
 * accepts, which is a direct reading of the ledger rather than a re-modelling
 * of it: a gate in the product is a gate in the workflow.
 */
import { defineWorkflow, type WorkflowDefinition } from "@intx/workflow";
import { gateStepId, stageEnds, stageSteps } from "./stage-loop.js";
import {
  LEDGER,
  STAGES,
  type Command,
  type Stage,
} from "../ledger.js";

export const PROJECT_LIFECYCLE_ID = "solutions-builder.project-lifecycle";

/**
 * The naming agent step: runs once, at the top level, alongside stage 1 —
 * never gating it — from the run's opening problem statement, and writes the
 * project's name as its output. It carries no `after`, so it starts the
 * moment the run fires rather than depending on any stage's steps, and it is
 * additive the same way the build agent is: the in-process definition below
 * never carries it (no step here carries an agent — see the module doc), and
 * the rendered lifecycle (`lifecycle-source.ts`) adds it only once an
 * offering exists to run it against.
 */
export const NAME_STEP_ID = "name";

/** The step a stage ends at: its gate. Stable, and referenced by the run projection. */
export function stageStepId(stage: Stage): string {
  return gateStepId(stage);
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
  let steps: Record<string, unknown> = {};
  let previousEnds: string[] | null = null;

  for (const stage of STAGES) {
    // A stage's loop starts after the previous stage's gate — whichever of its
    // two gates ran — so the nine run in order and every one of them waits for
    // a person before the next.
    steps = { ...steps, ...stageSteps(stage, previousEnds) };
    previousEnds = stageEnds(stage);
  }

  return defineWorkflow({
    id: PROJECT_LIFECYCLE_ID,
    // Projects are started by a person, never by a schedule or an inbound mail.
    triggers: [{ type: "manual" }],
    steps: steps as never,
    state: {
      schema: {
        projectId: "string",
        stage: "number",
        state: "string",
      } as never,
    },
  });
}
