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
import {
  BUILD_STEP_ID,
  BUILD_STEP_TIMEOUT_MS,
  MAX_REVISIONS,
  ROUND_STEP_ID,
  STAGE_WORKFLOW_ID,
} from "./stage-loop.js";
import { agentFor } from "../kit.js";
import { STAGES } from "../ledger.js";

/**
 * What the deployed package depends on. `@intx/workflow` is a workspace member
 * of the asset (the vendored revision, shipped beside the workflow by
 * `apps/hub/src/workflow-closure.ts`); everything else comes from npm. `hono` is imported by
 * nothing here: it satisfies the peer dependency `@logtape/hono` declares
 * inside `@intx/log`, which the closure resolver refuses to leave unmet.
 */
export const WORKFLOW_PACKAGE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/workflow": "workspace:*",
  "@intx/agent": "workspace:*",
  "@intx/tools-posix": "workspace:*",
  hono: "^4.0.0",
};

/**
 * The inference source the stage 8 build agent declares: a (provider plugin,
 * canonical model) pair the deploy pins against the tenant's offerings. Absent
 * when no offering exists yet; the lifecycle then carries no agent step and
 * stage 8 is gates only, which is what the in-process definition builds.
 */
export type BuildSource = { readonly provider: string; readonly model: string };

export type LifecycleSourceOptions = { readonly buildSource?: BuildSource };

/** The stage whose rounds run the build agent. */
export const BUILD_STAGE = 8;

export const LIFECYCLE_ENTRY_PATH = "workflow.js";

/** The entry module the workflow package ships, as source. */
export function lifecycleEntrySource(options: LifecycleSourceOptions = {}): string {
  const build = options.buildSource;
  // The rendered package imports these; this module does not. Interpolated so
  // the boundary check reads the package's own imports, not the template's.
  const buildImports = build
    ? `import { defineAgent } from ${JSON.stringify("@intx/agent")};
import { posix } from ${JSON.stringify("@intx/tools-posix/sidecar-bundle")};
`
    : "";
  // The build agent is the kit's stage 8 specialist, given a workspace. Every
  // posix tool asks before it acts, so a tool call parks the step and the hub
  // records an approval a person resolves; the agent cannot act on its own.
  const buildAgent = build
    ? `
const BUILD_SOURCE = ${JSON.stringify(build)};
const buildAgent = defineAgent({
  id: ${JSON.stringify(agentFor(BUILD_STAGE).id)},
  systemPrompt: ${JSON.stringify(agentFor(BUILD_STAGE).system)},
  tools: [posix],
  capabilities: [],
  inference: { sources: [BUILD_SOURCE] },
});
`
    : "";
  const buildStep = build
    ? `
      ${JSON.stringify(BUILD_STEP_ID)}: step({
        agent: buildAgent,
        input: { from: "steps." + ROUND + ".output" },
        timeout: ${BUILD_STEP_TIMEOUT_MS},
        triggers: 1,
        drainBehavior: "wait",
        after: [ROUND],
      }),`
    : "";
  return `import { awaitSignal, defineWorkflow, loop, step } from "@intx/workflow/definition";
${buildImports}
const STAGES = ${JSON.stringify([...STAGES])};
const STAGE_ID = ${JSON.stringify(STAGE_WORKFLOW_ID)};
const MAX_REVISIONS = ${MAX_REVISIONS};
const ROUND = ${JSON.stringify(ROUND_STEP_ID)};
const BUILD_STAGE = ${BUILD_STAGE};
${buildAgent}
// One iteration: the workflow waits to hear what the person did. One gate, so
// the first command to arrive ends the round; the loops module decides whether
// the loop goes on. At the build stage the round is followed by the build
// agent, which runs under the sidecar on what the person asked for.
function iteration(stage) {
  const steps = {
    [ROUND]: awaitSignal({ name: STAGE_ID + "." + stage + ".round", drainBehavior: "wait" }),
  };
  if (stage === BUILD_STAGE) {
    Object.assign(steps, {${buildStep}
    });
  }
  return defineWorkflow({
    id: STAGE_ID + ".iteration." + stage,
    triggers: [{ type: "manual" }],
    steps,
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
