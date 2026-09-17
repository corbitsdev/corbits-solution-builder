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
  DECIDE_STEP_ID,
  DELIVERY_STAGE,
  DELIVERY_STEP_ID,
  DRAFT_STEP_ID,
  DRAFT_STEP_TIMEOUT_MS,
  EVALUATE_STEP_ID,
  EVALUATED_STAGE,
  MAX_REVISIONS,
  NO_DRAFT_STEP_ID,
  REQUIREMENTS_STEP_ID,
  ROUND_STEP_ID,
  STAGE_WORKFLOW_ID,
  agentStepIds,
  gatedStepCount,
} from "./stage-loop.js";
import { agentById, agentFor, panelPrincipals, type AgentRole } from "../kit.js";
import { STAGES, type Stage } from "../ledger.js";
import { skillTextFor } from "../seed-kit.js";

/**
 * What the deployed package depends on. `@intx/workflow` is a workspace member
 * of the asset (the vendored revision, shipped beside the workflow by
 * `apps/hub/src/workflow-closure.ts`); everything else comes from npm. `hono` is imported by
 * nothing here: it satisfies the peer dependency `@logtape/hono` declares
 * inside `@intx/log`, which the closure resolver refuses to leave unmet.
 * `@solutions-builder/tools-deck` is the deck-rendering tool stage 5's
 * specialist carries: it ships beside the workflow the same way
 * `@intx/tools-posix` does, so a running workflow renders a stakeholder's
 * slides itself instead of asking the hub to do it (`apps/hub/src/workflow-closure.ts`
 * ships its files, and `@solutions-builder/app`'s deck authoring it depends
 * on, into the same asset). `@solutions-builder/tools-delivery` is the same
 * shape for stage 9's delivery-verifier: it summarizes a manifest's
 * already-checked descriptors into a completeness report without a hub
 * round trip.
 */
export const WORKFLOW_PACKAGE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/workflow": "workspace:*",
  "@intx/agent": "workspace:*",
  "@intx/tools-posix": "workspace:*",
  "@solutions-builder/tools-deck": "workspace:*",
  "@solutions-builder/tools-delivery": "workspace:*",
  hono: "^4.0.0",
};

/**
 * The (provider plugin, canonical model) pair every rendered agent step
 * declares as its inference source, pinned against one of the tenant's
 * offerings. Absent when no offering exists yet; the lifecycle then carries
 * no agent step at all and every stage is gates only, which is what the
 * in-process definition builds.
 */
export type InferenceSourcePin = { readonly provider: string; readonly model: string };

export type LifecycleSourceOptions = {
  readonly source?: InferenceSourcePin;
  /** The project's audience packages, in stage 5 fan-out order. */
  readonly audiences?: readonly { readonly name: string; readonly role: string }[];
};

/** The stage whose rounds run the build agent. */
export const BUILD_STAGE = 8;

/** The stage whose rounds write one package per stakeholder, each behind its own gate. */
export const PACKAGE_STAGE = 5;

// `DELIVERY_STAGE` (the stage whose specialist checks a delivery manifest) is
// defined in `stage-loop.js`, imported above, and re-exported here: it names
// both the stage number and, via `DELIVERY_STEP_ID`, the step id that number
// renders to, and `check-ledger.ts` reads both off this module the same way
// it reads `BUILD_STAGE`.
export { DELIVERY_STAGE };

/**
 * The stage whose rounds write the requirements and then the plan, each
 * behind its own gate: the requirements in one round, the plan and its
 * reviews in the next, once the host can hand the plan the requirements.
 */
export const PLAN_STAGE = 6;

/** Every stage whose round is followed by its kit specialist under the "draft" id. */
const DRAFTED_STAGES: readonly Stage[] = [1, 2, 3, 4, 6, 7, 9];

export const LIFECYCLE_ENTRY_PATH = "workflow.js";

/**
 * One agent step the rendered iteration wires: its id, the role that runs it,
 * its input, and whether it sits behind a gate reading the round's "wanted"
 * flag at its own index.
 */
type AgentStepSpec = {
  readonly id: string;
  readonly roleId: string;
  readonly input: { readonly from: string };
  readonly gated: boolean;
};

/**
 * A role's kit prompt has no runtime after this point to load a skill from: an
 * agent step's `systemPrompt` is a static string baked in at render time, so a
 * skill the role carries reaches the model only if it rides along here. The
 * skill asset written by `apps/hub/src/skill-assets.ts` is the platform-side
 * record of the same text, not a second place it is read from.
 */
function renderedPrompt(role: AgentRole): string {
  return `${role.system}\n\n${skillTextFor(role)}`;
}

/** The role that runs a given agent step id at a given stage. */
function roleIdForStep(stage: Stage, stepId: string): string {
  if (stage === 5) return agentFor(5).id;
  if (stage === EVALUATED_STAGE && stepId === EVALUATE_STEP_ID) {
    const evaluator = agentById("brief-evaluator");
    if (!evaluator) throw new Error("brief-evaluator role missing from the kit");
    return evaluator.id;
  }
  if (stage === PLAN_STAGE && stepId === REQUIREMENTS_STEP_ID) {
    const author = agentById("requirements-author");
    if (!author) throw new Error("requirements-author role missing from the kit");
    return author.id;
  }
  if (stage === PLAN_STAGE && stepId !== DRAFT_STEP_ID) {
    const specialty = stepId.replace(/^review-/, "");
    const role = panelPrincipals().find((entry) => entry.id === `senior-engineer-${specialty}`);
    if (!role) throw new Error(`No panel principal for step ${stepId}`);
    return role.id;
  }
  return agentFor(stage).id;
}

/**
 * What a given agent step reads: the round's prompt, or the draft it revises.
 * A gated step reads its own slot of the round's prompts, at the same index
 * as its "wanted" flag.
 */
function inputForStep(stage: Stage, stepId: string, index: number, audienceCount: number): { from: string } {
  if (index < gatedStepCount(stage, audienceCount)) return { from: `steps.${ROUND_STEP_ID}.output.prompts[${index}]` };
  // Stage 9's one step is named `DELIVERY_STEP_ID`, not `DRAFT_STEP_ID` (see
  // its definition), but is the same "first, ungated, reads the round's
  // prompt" shape every other single-step drafted stage has.
  if (stepId === DRAFT_STEP_ID || stepId === DELIVERY_STEP_ID) return { from: `steps.${ROUND_STEP_ID}.output.prompt` };
  return { from: `steps.${DRAFT_STEP_ID}.output.reply` };
}

/** Every agent step spec for every stage that carries one, keyed by stage number. */
function agentStepSpecsByStage(audienceCount: number): Readonly<Record<number, readonly AgentStepSpec[]>> {
  const out: Record<number, AgentStepSpec[]> = {};
  for (const stage of [...DRAFTED_STAGES, 5 as Stage]) {
    out[stage] = agentStepIds(stage, audienceCount).map((id, index) => ({
      id,
      roleId: roleIdForStep(stage, id),
      input: inputForStep(stage, id, index, audienceCount),
      gated: index < gatedStepCount(stage, audienceCount),
    }));
  }
  return out;
}

/** Every role a rendered agent step references, deduplicated by role id. */
function rolesInUse(audienceCount: number): AgentRole[] {
  const specs = agentStepSpecsByStage(audienceCount);
  const byId = new Map<string, AgentRole>();
  for (const list of Object.values(specs)) {
    for (const spec of list) {
      if (byId.has(spec.roleId)) continue;
      const role = agentById(spec.roleId);
      if (!role) throw new Error(`No seeded role for id ${spec.roleId}`);
      byId.set(spec.roleId, role);
    }
  }
  return [...byId.values()];
}

/** The entry module the workflow package ships, as source. */
export function lifecycleEntrySource(options: LifecycleSourceOptions = {}): string {
  const source = options.source;
  const audienceCount = options.audiences?.length ?? 0;
  // The rendered package imports these; this module does not. Interpolated so
  // the boundary check reads the package's own imports, not the template's.
  const sourceImports = source
    ? `import { defineAgent } from ${JSON.stringify("@intx/agent")};
import { posix } from ${JSON.stringify("@intx/tools-posix/sidecar-bundle")};
import { deck } from ${JSON.stringify("@solutions-builder/tools-deck/sidecar-bundle")};
import { delivery } from ${JSON.stringify("@solutions-builder/tools-delivery/sidecar-bundle")};
`
    : "";
  // The build agent is the kit's stage 8 specialist, given a workspace. Every
  // posix tool asks before it acts, so a tool call parks the step and the hub
  // records an approval a person resolves; the agent cannot act on its own.
  const buildAgent = source
    ? `
const buildAgent = defineAgent({
  id: ${JSON.stringify(agentFor(BUILD_STAGE).id)},
  systemPrompt: ${JSON.stringify(renderedPrompt(agentFor(BUILD_STAGE)))},
  tools: [posix],
  capabilities: [],
  inference: { sources: [SOURCE] },
});
`
    : "";
  const buildStep = source
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
  // Every other stage's specialist: capabilities-free, pinned to the same
  // offering as the build agent. Rendered as pure data (ids, prompts,
  // selectors) and reassembled into `defineAgent` calls here, in the sidecar,
  // never carried across as functions. Stage 5's specialist carries the deck
  // renderer, since it is the one that turns a stakeholder's package into
  // slides; stage 9's specialist carries the delivery-status summarizer,
  // since it is the one that checks a manifest against what was built. Every
  // other rendered stage stays tools-free.
  const agentsBlock = source
    ? `
const AGENTS = {
${rolesInUse(audienceCount)
  .map((role) => {
    const tool =
      role.id === agentFor(PACKAGE_STAGE).id ? "deck" : role.id === agentFor(DELIVERY_STAGE).id ? "delivery" : "";
    return `  ${JSON.stringify(role.id)}: defineAgent({ id: ${JSON.stringify(role.id)}, systemPrompt: ${JSON.stringify(renderedPrompt(role))}, tools: [${tool}], capabilities: [], inference: { sources: [SOURCE] } }),`;
  })
  .join("\n")}
};
`
    : "";
  const agentStepSpecs = source
    ? `
const AGENT_STEP_SPECS = ${JSON.stringify(agentStepSpecsByStage(audienceCount))};
`
    : "";
  return `import { awaitSignal, defineWorkflow, escalation, gate, loop, step } from "@intx/workflow/definition";
${sourceImports}
const STAGES = ${JSON.stringify([...STAGES])};
const STAGE_ID = ${JSON.stringify(STAGE_WORKFLOW_ID)};
const MAX_REVISIONS = ${MAX_REVISIONS};
const ROUND = ${JSON.stringify(ROUND_STEP_ID)};
const DECIDE = ${JSON.stringify(DECIDE_STEP_ID)};
const NO_DRAFT = ${JSON.stringify(NO_DRAFT_STEP_ID)};
const DRAFT_TIMEOUT = ${DRAFT_STEP_TIMEOUT_MS};
const BUILD_STAGE = ${BUILD_STAGE};
${source ? `const SOURCE = ${JSON.stringify(source)};` : ""}
${buildAgent}${agentsBlock}${agentStepSpecs}
// One iteration: the workflow waits to hear what the person did. A gate right
// after the round reads whether this round asked for a draft; if so, the
// stage's specialist steps run in order, each after the last. If not, the
// gate's empty branch is a pure-data escalation — nothing to do this round.
// At the build stage the round is followed by the build agent on every
// round, regardless of the draft flag: that behaviour is unchanged.
function iteration(stage) {
  const steps = {
    [ROUND]: awaitSignal({ name: STAGE_ID + "." + stage + ".round", drainBehavior: "wait" }),
  };
  if (stage === BUILD_STAGE) {
    Object.assign(steps, {${buildStep}
    });
  } else if (typeof AGENT_STEP_SPECS !== "undefined") {
    const specs = AGENT_STEP_SPECS[stage] || [];
    if (specs.length > 0) {
      // A round may ask for only some of a stage's steps: at stage 5 the
      // packages that failed last time, or one to be written again; at
      // stage 6 the requirements in one round and the plan in the next.
      // Such a step sits behind its own gate, read from the round's
      // "wanted" flags; one not wanted is skipped, and the next gate joins
      // both branches so the chain goes on either way. A step with no gate
      // of its own follows the step before it, never that step's skip
      // marker: a review of a plan not written this round is skipped with
      // the plan.
      const first = specs[0].gated ? "pick-0" : specs[0].id;
      Object.assign(steps, {
        [DECIDE]: gate({
          when: { from: "steps." + ROUND + ".output.draft" },
          then: first,
          else: NO_DRAFT,
          after: [ROUND],
        }),
        [NO_DRAFT]: escalation({ to: NO_DRAFT, after: [DECIDE] }),
      });
      let previous = [DECIDE];
      specs.forEach((spec, index) => {
        const agentStep = (after) =>
          step({
            agent: AGENTS[spec.roleId],
            input: spec.input,
            // The round carries the call's options — the output cap the
            // person set for a design — since the agent is fixed at deploy.
            inference: { from: "steps." + ROUND + ".output.inference" },
            timeout: DRAFT_TIMEOUT,
            drainBehavior: "wait",
            after,
          });
        if (spec.gated) {
          const pick = "pick-" + index;
          const skip = "skip-" + index;
          Object.assign(steps, {
            [pick]: gate({
              when: { from: "steps." + ROUND + ".output.wanted[" + index + "]" },
              then: spec.id,
              else: skip,
              after: previous,
            }),
            [skip]: escalation({ to: skip, after: [pick] }),
            [spec.id]: agentStep([pick]),
          });
          previous = [spec.id, skip];
        } else {
          const after = index > 0 && specs[index - 1].gated ? [specs[index - 1].id] : previous;
          Object.assign(steps, { [spec.id]: agentStep(after) });
          previous = [spec.id];
        }
      });
    }
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
