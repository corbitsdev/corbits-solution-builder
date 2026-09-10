/**
 * The lifecycle as workflow source.
 *
 * The hub deploys code, not data: the probe sidecar evaluates the package's
 * entry module and freezes what it exports. An inert-JSON entry was enough
 * while every step was a gate, but an agent step carries tool factories,
 * which are functions, so the entry has to be a module that builds the
 * definition with `@intx/workflow` at evaluation time. This is that module,
 * rendered as text with the ledger's constants baked in.
 *
 * The shape here and the shape `stage-loop.ts`/`project-lifecycle.ts` build
 * in-process must be the same definition. `check:ledger` evaluates this
 * source against the workspace's `@intx/workflow` and compares the two, so a
 * drift fails the gate rather than the probe.
 */
import { PROJECT_LIFECYCLE_ID } from "./project-lifecycle.js";
import { MAX_REVISIONS, ROUND_STEP_ID, STAGE_WORKFLOW_ID } from "./stage-loop.js";
import { STAGES } from "../ledger.js";

/**
 * What the deployed package depends on, fetched from npm by the hub (to pin
 * the closure) and by the sidecar (to lay it out). `hono` is imported by
 * nothing here: it satisfies the peer dependency `@logtape/hono` declares
 * inside `@intx/log`, which the closure resolver refuses to leave unmet.
 */
export const WORKFLOW_PACKAGE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/workflow": "0.3.0",
  hono: "^4.0.0",
};

export const LIFECYCLE_ENTRY_PATH = "workflow.js";

/** The entry module the workflow package ships, as source. */
export function lifecycleEntrySource(): string {
  return `import { awaitSignal, defineWorkflow, loop } from "@intx/workflow/definition";

const STAGES = ${JSON.stringify([...STAGES])};
const STAGE_ID = ${JSON.stringify(STAGE_WORKFLOW_ID)};
const MAX_REVISIONS = ${MAX_REVISIONS};
const ROUND = ${JSON.stringify(ROUND_STEP_ID)};

// One iteration: the workflow waits to hear what the person did. One gate, so
// the first command to arrive ends the round; the loops module decides whether
// the loop goes on.
function iteration(stage) {
  return defineWorkflow({
    id: STAGE_ID + ".iteration." + stage,
    triggers: [{ type: "manual" }],
    steps: {
      [ROUND]: awaitSignal({ name: STAGE_ID + "." + stage + ".round", drainBehavior: "wait" }),
    },
  });
}

// A stage is a bounded revise loop and two human gates: the ordinary one, and
// the one reached when the loop ran out of revisions. The runtime prunes a
// loop's exhaustion branch on convergence, so the two gates cannot be one
// step; the next stage follows either.
function stageSteps(stage, after) {
  return {
    ["revise-" + stage]: loop({
      body: iteration(stage),
      while: "stillOpen",
      carry: "carryRound",
      maxIterations: MAX_REVISIONS,
      onExhausted: "exhausted-" + stage,
      drainBehavior: "wait",
      ...(after ? { after } : {}),
    }),
    ["gate-" + stage]: awaitSignal({
      name: STAGE_ID + "." + stage + ".approve",
      drainBehavior: "wait",
      after: ["revise-" + stage],
    }),
    ["exhausted-" + stage]: awaitSignal({
      name: STAGE_ID + "." + stage + ".approve-after-exhaustion",
      drainBehavior: "wait",
      after: ["revise-" + stage],
    }),
  };
}

let steps = {};
let previousEnds = null;
for (const stage of STAGES) {
  steps = { ...steps, ...stageSteps(stage, previousEnds) };
  previousEnds = ["gate-" + stage, "exhausted-" + stage];
}

export default defineWorkflow({
  id: ${JSON.stringify(PROJECT_LIFECYCLE_ID)},
  triggers: [{ type: "manual" }],
  steps,
});
`;
}

/**
 * The sidecar's live-to-inert projector reifies `state.schema` through an
 * arktype `Type`, which a deployed definition cannot carry; ours are arktype
 * *definitions* the runtime never validates against. The deployed package
 * declares no state schema, and this strips it from the in-process definition
 * so the two can be compared.
 */
export function withoutStateSchemas<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => withoutStateSchemas(entry)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "state" && entry && typeof entry === "object" && "schema" in (entry as object)) continue;
      out[key] = withoutStateSchemas(entry);
    }
    return out as T;
  }
  return value;
}
