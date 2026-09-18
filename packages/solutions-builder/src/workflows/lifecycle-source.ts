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
 * in-process must be the same definition: one `onTrigger` chat section
 * (`chat`, on mail) carrying every person input for every stage, plus a flat
 * approve chain of top-level signal gates. The deployed package cannot import
 * `stage-loop.ts`'s `chatBody()`/`approveChain()` directly — the sidecar only
 * ships the `@intx/workflow` definition API, not this package's source — so
 * this mirrors their construction in the rendered JS text instead.
 * `check:ledger` evaluates this source against the workspace's own
 * `@intx/workflow` and compares the two, so a drift fails the gate rather
 * than the probe.
 */
import { NAME_STEP_ID, PROJECT_LIFECYCLE_ID } from "./project-lifecycle.js";
import {
  BUILD_STEP_ID,
  BUILD_STEP_TIMEOUT_MS,
  CHAT_STEP_ID,
  DELIVERY_STAGE,
  DELIVERY_STEP_ID,
  DRAFT_STEP_TIMEOUT_MS,
  EVALUATE_STEP_ID,
  NONE_STEP_ID,
  REQUIREMENTS_STEP_ID,
  ROUTE_STEP_ID,
  STAGE_WORKFLOW_ID,
  UNROUTED_STEP_ID,
  agentStepIds,
  approveSignal,
  draftStepId,
  evidenceSignal,
  freezeSignal,
  gateStepId,
  routerStepId,
} from "./stage-loop.js";
import { agentById, agentFor, panelPrincipals, type AgentRole } from "../kit.js";
import type { Stage } from "../ledger.js";
import { skillTextFor } from "../seed-kit.js";
import { DESIGNER_TOKENS_DEFAULT } from "../designer-settings.js";

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
  "@solutions-builder/app": "workspace:*",
  "@solutions-builder/tools-deck": "workspace:*",
  "@solutions-builder/tools-delivery": "workspace:*",
  hono: "^4.0.0",
};

/**
 * The (provider plugin, canonical model) pair every rendered agent step
 * declares as its inference source, pinned against one of the tenant's
 * offerings. Absent when no offering exists yet; the lifecycle then carries
 * no agent step at all and the chat body's router leads every `is-N`
 * straight to `none`, which is what the in-process definition builds.
 */
export type InferenceSourcePin = { readonly provider: string; readonly model: string };

export type LifecycleSourceOptions = {
  readonly source?: InferenceSourcePin;
  /** The project's audience packages, in stage 5 fan-out order. */
  readonly audiences?: readonly { readonly name: string; readonly role: string }[];
  /** How many audiences must say proceed before stage 5 approves; the gate carries the tally. */
  readonly audienceQuorum?: number;
  /**
   * Stage 4's own output-token cap, read from the tenant's designer settings
   * asset at deploy time. Baked in the same way `audienceQuorum` is: the
   * client no longer computes this (there is no host route left to do it),
   * so the round's own `inference.maxTokens` is a client literal the
   * workflow does not trust for stage 4 — this literal overrides it there.
   */
  readonly designerMaxTokens?: number;
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

/** Every stage the chat section's router covers: every stage but delivery. */
const CHAT_STAGES: readonly Stage[] = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const LIFECYCLE_ENTRY_PATH = "workflow.js";

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

/**
 * The role that runs a given chat-body agent step. Every step id the chat
 * section renders carries its stage number (`draft-2`, `package-5-0`,
 * `review-6-<specialty>`, …), so the role is read off the id's own shape
 * rather than a fixed step id, plus the stage it belongs to.
 */
function roleIdForStep(stage: Stage, stepId: string): string {
  if (stage === PACKAGE_STAGE) return agentFor(PACKAGE_STAGE).id;
  if (stepId === EVALUATE_STEP_ID) {
    const evaluator = agentById("brief-evaluator");
    if (!evaluator) throw new Error("brief-evaluator role missing from the kit");
    return evaluator.id;
  }
  if (stepId === REQUIREMENTS_STEP_ID) {
    const author = agentById("requirements-author");
    if (!author) throw new Error("requirements-author role missing from the kit");
    return author.id;
  }
  if (stage === PLAN_STAGE && stepId.startsWith("review-")) {
    const specialty = stepId.replace(/^review-6-/, "");
    const role = panelPrincipals().find((entry) => entry.id === `senior-engineer-${specialty}`);
    if (!role) throw new Error(`No panel principal for step ${stepId}`);
    return role.id;
  }
  return agentFor(stage).id;
}

/**
 * What a given chat-body agent step reads. Every step reads the router's own
 * `route` output as a whole (the person's parsed intent for this occurrence)
 * except the ones chained after another specialist within the same stage:
 * stage 1's evaluator reads its draft's reply, stage 6's plan draft reads the
 * requirements' reply, and stage 6's reviews read the plan's reply.
 */
function inputForStep(stage: Stage, stepId: string): { readonly from: string } {
  if (stepId === EVALUATE_STEP_ID) return { from: `steps.${draftStepId(stage)}.output.reply` };
  if (stage === PLAN_STAGE && stepId === draftStepId(stage)) {
    return { from: `steps.${REQUIREMENTS_STEP_ID}.output.reply` };
  }
  if (stage === PLAN_STAGE && stepId.startsWith("review-")) {
    return { from: `steps.${draftStepId(stage)}.output.reply` };
  }
  return { from: `steps.${ROUTE_STEP_ID}.output` };
}

/**
 * What a given chat-body agent step follows. A stage's first step follows the
 * router's branch for that stage (`is-N`); stage 5's packages all follow
 * `is-5` directly rather than each other, since a round may write one
 * stakeholder's package and leave the rest; stage 6's plan follows its
 * requirements, and every review follows the plan directly (not each other),
 * since a round that skips the plan skips its reviews with it.
 */
function afterForStep(stage: Stage, stepId: string): string[] {
  if (stepId === EVALUATE_STEP_ID) return [draftStepId(stage)];
  if (stage === PLAN_STAGE && stepId === draftStepId(stage)) return [REQUIREMENTS_STEP_ID];
  if (stage === PLAN_STAGE && stepId.startsWith("review-")) return [draftStepId(stage)];
  return [routerStepId(stage)];
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
import { delivery, deliver } from ${JSON.stringify("@solutions-builder/tools-delivery/sidecar-bundle")};
`
    : "";

  // One entry per chat-body agent step, and the id of the first step of each
  // stage (or `none` when that stage renders no agent step at all — a stage 5
  // with no audiences, or every stage when there is no offering to run
  // against yet). Every role a step references is collected once, by id.
  const chatStepEntries: string[] = [];
  const routerThens = new Map<Stage, string>();
  const rolesUsed = new Map<string, AgentRole>();

  for (const stage of CHAT_STAGES) {
    const ids = source ? agentStepIds(stage, audienceCount) : [];
    routerThens.set(stage, ids.length > 0 ? ids[0]! : NONE_STEP_ID);
    if (!source) continue;
    for (const id of ids) {
      const roleId = roleIdForStep(stage, id);
      const role = agentById(roleId);
      if (!role) throw new Error(`No seeded role for id ${roleId}`);
      rolesUsed.set(roleId, role);
      const input = inputForStep(stage, id);
      const after = afterForStep(stage, id);
      // Stage 4 alone does not trust the round's own inference cap: there is
      // no host route left to police it, so the deploy-time designer setting
      // (baked in below) wins over whatever the person's message carried.
      const inference =
        stage === 4
          ? "{ literal: { maxTokens: DESIGNER_MAX_TOKENS } }"
          : `{ from: ${JSON.stringify(`steps.${ROUTE_STEP_ID}.output.inference`)} }`;
      const timeout = id === BUILD_STEP_ID ? "BUILD_TIMEOUT" : "DRAFT_TIMEOUT";
      chatStepEntries.push(`    ${JSON.stringify(id)}: step({
      agent: AGENTS[${JSON.stringify(roleId)}],
      input: ${JSON.stringify(input)},
      inference: ${inference},
      timeout: ${timeout},
      drainBehavior: "wait",
      triggers: 1,
      after: ${JSON.stringify(after)},
    }),`);
    }
  }

  // Every rendered role, reassembled into `defineAgent` calls in the sidecar
  // rather than carried across as functions. Stage 5's specialist carries the
  // deck renderer; stage 8's build agent carries the posix tools; every other
  // rendered role stays tools-free (stage 9's delivery specialist is its own
  // standalone agent below, since `delivery-check` sits outside the chat body).
  const agentsBlock = source
    ? `
const AGENTS = {
${[...rolesUsed.values()]
  .map((role) => {
    const tool =
      role.id === agentFor(PACKAGE_STAGE).id ? "deck" : role.id === agentFor(BUILD_STAGE).id ? "posix" : "";
    return `  ${JSON.stringify(role.id)}: defineAgent({ id: ${JSON.stringify(role.id)}, systemPrompt: ${JSON.stringify(renderedPrompt(role))}, tools: [${tool}], capabilities: [], inference: { sources: [SOURCE] } }),`;
  })
  .join("\n")}
};
`
    : "";

  // The router: a binary gate chain, `is-1` through `is-8`, mirroring
  // `chatBody()` exactly. `is-1` follows `route`; every other `is-N` follows
  // `is-(N-1)`. Every stage's `then`, when it carries no agent step, lands on
  // `none`. The last stage's `else` is its own terminal, `unrouted` — not
  // `none` — since the deploy validator rejects a gate whose `then` and
  // `else` are the same step, which `is-8` would otherwise hit in the
  // gates-only render (its `then` falls back to `none` too, with no offering).
  const routerEntries: string[] = [];
  CHAT_STAGES.forEach((stage, index) => {
    const id = routerStepId(stage);
    const after = index === 0 ? [ROUTE_STEP_ID] : [routerStepId(CHAT_STAGES[index - 1]!)];
    const elseId = index === CHAT_STAGES.length - 1 ? UNROUTED_STEP_ID : routerStepId(CHAT_STAGES[index + 1]!);
    routerEntries.push(`    ${JSON.stringify(id)}: gate({
      when: { from: ${JSON.stringify(`steps.${ROUTE_STEP_ID}.output.at.${stage}`)} },
      then: ${JSON.stringify(routerThens.get(stage))},
      else: ${JSON.stringify(elseId)},
      after: ${JSON.stringify(after)},
    }),`);
  });
  const lastStage = CHAT_STAGES[CHAT_STAGES.length - 1]!;
  const noneEntry = `    ${JSON.stringify(NONE_STEP_ID)}: escalation({ to: ${JSON.stringify(NONE_STEP_ID)}, after: [${JSON.stringify(routerStepId(lastStage))}] }),`;
  const unroutedEntry = `    ${JSON.stringify(UNROUTED_STEP_ID)}: escalation({ to: ${JSON.stringify(UNROUTED_STEP_ID)}, after: [${JSON.stringify(routerStepId(lastStage))}] }),`;
  const routeEntry = `    ${JSON.stringify(ROUTE_STEP_ID)}: action({ handler: "routeMessage", input: { from: "trigger.payload" } }),`;

  // The chat section's body: a full sub-DAG, authored inline and re-triggered
  // by each occurrence of the mail address it subscribes to. Every person
  // input for every stage arrives here as conversation mail (see the module
  // doc), so `route` parses it once and the router above picks the branch.
  const chatBodySource = `defineWorkflow({
    id: ${JSON.stringify(`${STAGE_WORKFLOW_ID}.chat`)},
    triggers: [{ type: "manual" }],
    steps: {
${routeEntry}
${routerEntries.join("\n")}
${noneEntry}
${unroutedEntry}
${chatStepEntries.join("\n")}
    },
  })`;

  // The naming agent: the kit's namer, given the run's opening problem
  // statement. Additive the same way every other agent step is — rendered
  // only once an offering exists — and never gates stage 1: it carries no
  // `after`, so it starts the instant the run fires. Input is the whole
  // `trigger.payload` (a mail envelope): the invoker projects its text/plain
  // parts into the namer's inbound turn when it recognizes the shape as
  // `Mail`, the same way `route`'s own input does.
  const namerRole = agentById("namer");
  if (source && !namerRole) throw new Error("namer role missing from the kit");
  const namerAgent = source
    ? `
const namerAgent = defineAgent({
  id: ${JSON.stringify(namerRole!.id)},
  systemPrompt: ${JSON.stringify(renderedPrompt(namerRole!))},
  tools: [],
  capabilities: [],
  inference: { sources: [SOURCE] },
});
`
    : "";
  const nameEntry = source
    ? `    ${JSON.stringify(NAME_STEP_ID)}: step({
      agent: namerAgent,
      input: { from: "trigger.payload" },
      timeout: DRAFT_TIMEOUT,
      drainBehavior: "wait",
    }),`
    : "";

  // Stage 9's own specialist: a standalone step after the approve chain's
  // last gate, not part of the chat body's router (`routeMessage`'s output
  // only ever carries flags for stages 1..8 — see admit.ts). It carries the
  // delivery-status and deliver tools, the way the build agent carries posix:
  // the deliver tool's own `approval: "ask"` is stage 9's gate, not a named
  // signal.
  const deliveryAgent = source
    ? `
const deliveryAgent = defineAgent({
  id: ${JSON.stringify(agentFor(DELIVERY_STAGE).id)},
  systemPrompt: ${JSON.stringify(renderedPrompt(agentFor(DELIVERY_STAGE)))},
  tools: [delivery, deliver],
  capabilities: [],
  inference: { sources: [SOURCE] },
});
`
    : "";
  const deliveryEntry = source
    ? `    ${JSON.stringify(DELIVERY_STEP_ID)}: step({
      agent: deliveryAgent,
      input: { from: "trigger.payload" },
      timeout: DRAFT_TIMEOUT,
      drainBehavior: "wait",
      triggers: 1,
      after: [${JSON.stringify(gateStepId(BUILD_STAGE as Stage))}],
    }),`
    : "";

  // The approve chain, mirroring `approveChain()` exactly: gate-1 through
  // gate-7 chained in order, then freeze, then evidence, then gate-8 — the
  // one place the flat N-follows-(N-1) chain bends, since a stage-7 approval
  // only frees the run to be frozen into a build, and the build's own
  // evidence hand-off has to resolve before stage 8 can be approved. No
  // admit actions, no loops, no exhaustion caps: the ledger guard stays
  // client-side.
  const approveEntries: string[] = [];
  for (let stage = 1; stage <= 7; stage++) {
    const id = gateStepId(stage as Stage);
    const after = stage === 1 ? [] : [gateStepId((stage - 1) as Stage)];
    approveEntries.push(
      `    ${JSON.stringify(id)}: awaitSignal({ name: ${JSON.stringify(approveSignal(stage as Stage))}, drainBehavior: "wait"${after.length > 0 ? `, after: ${JSON.stringify(after)}` : ""} }),`,
    );
  }
  const freezeEntry = `    "freeze": awaitSignal({ name: ${JSON.stringify(freezeSignal())}, drainBehavior: "wait", after: [${JSON.stringify(gateStepId(7 as Stage))}] }),`;
  const evidenceEntry = `    "evidence": awaitSignal({ name: ${JSON.stringify(evidenceSignal(BUILD_STAGE as Stage))}, drainBehavior: "wait", after: ["freeze"] }),`;
  const gate8Entry = `    ${JSON.stringify(gateStepId(BUILD_STAGE as Stage))}: awaitSignal({ name: ${JSON.stringify(approveSignal(BUILD_STAGE as Stage))}, drainBehavior: "wait", after: ["evidence"] }),`;

  return `import { action, awaitSignal, defineWorkflow, escalation, gate, onTrigger, step } from "@intx/workflow/definition";
${sourceImports}
const DRAFT_TIMEOUT = ${DRAFT_STEP_TIMEOUT_MS};
const BUILD_TIMEOUT = ${BUILD_STEP_TIMEOUT_MS};
// Stage 4's output-token cap, read off the tenant's designer settings asset
// at deploy time (packages/installer/src/designer-settings.ts) — the same
// place the settings page itself reads and writes. There is no host route
// left to compute this per occurrence, so the literal wins over whatever the
// person's own message carried for stage 4's specialist step.
const DESIGNER_MAX_TOKENS = ${JSON.stringify(options.designerMaxTokens ?? DESIGNER_TOKENS_DEFAULT)};
${source ? `const SOURCE = ${JSON.stringify(source)};` : ""}
${namerAgent}${deliveryAgent}${agentsBlock}
export default defineWorkflow({
  id: ${JSON.stringify(PROJECT_LIFECYCLE_ID)},
  triggers: [{ type: "manual" }],
  steps: {
${nameEntry}
    ${JSON.stringify(CHAT_STEP_ID)}: onTrigger({
      on: { type: "mail", to: ${JSON.stringify("lifecycle@solutions-builder.local")} },
      body: ${chatBodySource},
    }),
${approveEntries.join("\n")}
${freezeEntry}
${evidenceEntry}
${gate8Entry}
${deliveryEntry}
  },
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
