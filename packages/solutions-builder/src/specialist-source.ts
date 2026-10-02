/**
 * A stage specialist as workflow source.
 *
 * Every live failure traced back to the multi-step lifecycle workflow (loop
 * relay, onTrigger body env, seq collision). Workbench never hits that class
 * of bug because every agent it deploys is a single-step, mail-triggered,
 * unbounded-turn workflow (wb/apps/web/src/agent-deploy.ts's
 * `buildAgentDefinitionJson`): the hub runs it warm and mails the reply back.
 * This renders the same shape for one of our stage roles instead — one
 * specialist per stage per project, deployed lazily
 * (`packages/installer/src/specialist-deploy.ts`'s `ensureSpecialistDeployment`)
 * the first time that stage is opened.
 *
 * There is no chat section, no router, no approve chain: a specialist only
 * ever answers the mail addressed to its own run, and a stage's approval is
 * a client-side artifact write, not a signal this workflow waits on.
 */
import type { ArtifactKind } from "./artifacts.js";
import { ARTIFACT_WRITE_RULE, type AgentRole } from "./kit.js";
import type { Stage } from "./ledger.js";
import { skillTextFor } from "./seed-kit.js";

/** CL-8719: the `http` provider every specialist's `@corbits/artifacts/sidecar-bundle`
 *  resolves its `hub` credential handle against; one row per workspace, its
 *  `apiBaseUrl` the hub's own origin (see `installer/src/artifacts-credential.ts`). */
export const WORKFLOW_ARTIFACTS_PROVIDER_NAME = "sb-workflow-artifacts";

/** The credential name a specialist's `credentialBindings` names — fixed
 *  per role (#41 step 5), so the rendered entry is the same for every
 *  project. It resolves in the project's own tenant (#29), where the
 *  installer mints it, so one name per role is one credential per project. */
export function workflowArtifactsCredentialName(roleId: string): string {
  return `workflow-artifacts:${roleId}`;
}

/** Mirrors `apps/web/src/client.ts`'s `STAGE_DRAFT_KIND` — the artifact kind a
 *  stage's specialist writes its draft under. Kept here too (rather than
 *  imported from `apps/web`, the wrong dependency direction) because it is
 *  also what a specialist's own prompt is told to pass to `artifact_create`. */
export const STAGE_ARTIFACT_KIND: Readonly<Record<Stage, ArtifactKind>> = {
  1: "problem_brief",
  2: "solution_constraints",
  3: "chosen_approach",
  4: "design_artifact",
  5: "audience_package",
  6: "build_plan",
  7: "cost_approval",
  8: "build_evidence",
  9: "delivery_manifest",
};

/**
 * The (provider plugin, canonical model) pair a rendered agent step declares
 * as its inference source, pinned against one of the tenant's offerings.
 */
export type InferenceSourcePin = { readonly provider: string; readonly model: string };

/** The stage whose specialist supervises the build. The build itself runs
 *  through the host's bounded bridge (`apps/hub/src/corbits-exec.ts`), not
 *  in this specialist's sidecar: it carries no shell and no delivery tool. */
export const BUILD_STAGE = 8;

/** The stage whose rounds write one package per stakeholder, each behind its own gate. */
export const PACKAGE_STAGE = 5;

/** Mirrors `installer/src/specialist-deploy.ts`'s `DEFAULT_ROLE_KEY` (kept as
 *  its own literal here rather than imported, since `packages/installer`
 *  depends on this package and not the other way around). Stage 5 has one
 *  deployment per project under this key (#41 step 3): it receives the
 *  stage's opening (the approved design) and, one request at a time, the
 *  package asks that name a stakeholder (`AudiencePackages`'s "Write it").
 *  Its prompt writes one package per request, for the audience the request
 *  names, and renders that one deck -- never every stakeholder's in the
 *  one turn (CL-8873). */
const PRIMARY_ROLE_KEY = "primary";

/** The stage whose specialist checks a delivery manifest. */
export const DELIVERY_STAGE = 9;

/**
 * What every deployed specialist depends on. `@intx/workflow` is a workspace
 * member of the asset (the vendored revision, shipped beside the workflow by
 * `packages/installer/src/workflow-closure.ts`); everything else comes from
 * npm. `hono` is imported by nothing here: it satisfies the peer dependency
 * `@logtape/hono` declares inside `@intx/log`, which the closure resolver
 * refuses to leave unmet.
 */
export const SPECIALIST_BASE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/workflow": "workspace:*",
  "@intx/agent": "0.4.0",
  hono: "^4.0.0",
};

/** `@intx/tools-posix`: the shell and file tools. No stage carries it
 *  today; it stays in the packed union so a closure that ships it is
 *  unchanged. */
export const POSIX_TOOL_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/tools-posix": "0.4.0",
};

/**
 * Stage 5's deck-rendering tool, and the runtime package it authors decks
 * with. Both ship beside the workflow as members, the same way
 * `@intx/tools-posix` ships from npm, so a running workflow renders a
 * stakeholder's slides itself instead of asking the hub to do it.
 */
export const DECK_TOOL_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@solutions-builder/specialist-runtime": "workspace:*",
  "@solutions-builder/tools-deck": "workspace:*",
};

/** Stages 8 and 9's delivery tools (`publish_workspace`, `deliver`) and the
 *  runtime package that holds the delivery evidence and target verifier. */
export const DELIVERY_TOOL_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@solutions-builder/specialist-runtime": "workspace:*",
  "@solutions-builder/tools-delivery": "workspace:*",
};

/**
 * Everything any specialist can depend on: the union of the sets above.
 * `scripts/closure-pack.ts` packs this whole set once, so the static closure
 * the installer ships holds every member any stage may need; a specialist's
 * own `package.json` names only its share (`specialistDependencies`, #42).
 */
export const WORKFLOW_PACKAGE_DEPENDENCIES: Readonly<Record<string, string>> = {
  ...SPECIALIST_BASE_DEPENDENCIES,
  ...POSIX_TOOL_DEPENDENCIES,
  ...DECK_TOOL_DEPENDENCIES,
  ...DELIVERY_TOOL_DEPENDENCIES,
};

/**
 * The tools a specialist's rendered entry imports, by stage and role: what
 * `specialistEntrySource` writes into the entry, and therefore what the
 * pushed tree must ship as members and the package must depend on (#42).
 * One place decides, so an entry never imports a tool its closure lacks.
 */
export type SpecialistTooling = {
  /** `render_deck`: a stage 5 per-audience deployment, never the primary one (CL-8873). */
  readonly deck: boolean;
  /** `@intx/tools-posix`: the shell. No stage carries it; the build runs on the host. */
  readonly posix: boolean;
  /** `@solutions-builder/tools-delivery`: stage 9's `deliver`. */
  readonly delivery: boolean;
  /** `@corbits/artifacts`' generic bundle: opt-in. */
  readonly artifacts: boolean;
};

export function specialistTooling(options: {
  readonly stage: Stage;
  readonly roleKey?: string | undefined;
  readonly artifactTools?: boolean | undefined;
}): SpecialistTooling {
  const { stage, roleKey = PRIMARY_ROLE_KEY, artifactTools = false } = options;
  void roleKey;
  return {
    // The app draws and exports a stakeholder's slides from the deck outline
    // in the reply; a rendered file nothing reads only cost the model a turn
    // in which it reported the render instead of the package (#435).
    deck: false,
    // Stage 8 builds through the host's bridge; its specialist reviews the
    // worker's report and carries no shell.
    posix: false,
    delivery: stage === DELIVERY_STAGE,
    artifacts: artifactTools,
  };
}

/** The `dependencies` a specialist's own package declares: the base set plus
 *  each tool set its entry imports, nothing it does not ship. */
export function specialistDependencies(tooling: SpecialistTooling): Record<string, string> {
  return {
    ...SPECIALIST_BASE_DEPENDENCIES,
    ...(tooling.posix ? POSIX_TOOL_DEPENDENCIES : {}),
    ...(tooling.deck ? DECK_TOOL_DEPENDENCIES : {}),
    ...(tooling.delivery ? DELIVERY_TOOL_DEPENDENCIES : {}),
    ...(tooling.artifacts ? ARTIFACT_TOOL_DEPENDENCIES : {}),
  };
}

export const ARTIFACT_TOOL_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@corbits/artifacts": "workspace:*",
  "@standard-schema/spec": "^1.0.0",
};

/** One tool a rendered entry carries: the source lines that import (and,
 *  where a tool is built rather than imported, construct) it, and the
 *  identifier the entry hands to `defineAgent`'s `tools`. */
export type SpecialistToolImport = {
  /** The tool's module, for a reader; `lines` is what is rendered. */
  readonly package: string;
  readonly lines: readonly string[];
  readonly tool: string;
};

/**
 * What a role's entry carries beyond its kit prompt, declared as data (#41
 * step 1): the tools it imports and hands to its agent, the artifact kind
 * its stage's document is recorded under, the notes appended to its prompt,
 * and the tool package its `credentialBindings` entry names when it carries
 * artifact tools. `specialistEntrySource` renders exactly this and decides
 * nothing about a role itself. Nothing here is the project's: who a stage 5
 * package is for arrives with the request that asks for it (#41 step 3),
 * and the project a document belongs to is the run's own tenant, so the
 * prompt names no project (#41 step 4).
 */
export type SpecialistRoleSpec = {
  readonly tooling: SpecialistTooling;
  readonly toolImports: readonly SpecialistToolImport[];
  readonly artifactKind: ArtifactKind;
  /** Appended after the kit prompt and its skill text, in order. */
  readonly promptNotes: readonly string[];
  /** The tool package the `hub` credential binding is declared against, or null with no binding. */
  readonly credentialPackage: string | null;
};

/** What a specialist carrying the artifact tools is told about the document
 *  it writes (#41 step 4): its stage and the kind `artifact_create` records
 *  it under, both fixed per role. Which project it belongs to is the run's
 *  own tenant, never something the prompt names or the model supplies. */
function stageDocumentNote(stage: Stage, kind: ArtifactKind): string {
  return `## Stage document\n\nYou are the stage ${stage} specialist. Your document is recorded under the kind \`${kind}\`; pass that kind to artifact_create.`;
}

/** The `@corbits/artifacts` bundle (`artifact_create`/`artifact_write`), opt-in. */
const ARTIFACTS_IMPORT: SpecialistToolImport = {
  package: "@corbits/artifacts/sidecar-bundle",
  lines: [`import { artifacts } from ${JSON.stringify("@corbits/artifacts/sidecar-bundle")};`],
  tool: "artifacts",
};

/** Stage 5's `render_deck`. */
const DECK_IMPORT: SpecialistToolImport = {
  package: "@solutions-builder/tools-deck/sidecar-bundle",
  lines: [`import { deck } from ${JSON.stringify("@solutions-builder/tools-deck/sidecar-bundle")};`],
  tool: "deck",
};

/** Stage 9's `deliver`. */
const DELIVER_IMPORT: SpecialistToolImport = {
  package: "@solutions-builder/tools-delivery/sidecar-bundle",
  lines: [`import { deliver } from ${JSON.stringify("@solutions-builder/tools-delivery/sidecar-bundle")};`],
  tool: "deliver",
};

/** The shell, for a tooling that asks for it; none does today. */
const POSIX_IMPORT: SpecialistToolImport = {
  package: "@intx/tools-posix/sidecar-bundle",
  lines: [`import { posix } from ${JSON.stringify("@intx/tools-posix/sidecar-bundle")};`],
  tool: "posix",
};

/**
 * The spec for one deployment, from the same facts `specialistTooling`
 * reads: stage 9 carries `deliver`, and only a credential-bound deployment
 * declares the `hub` binding. Pure: the same inputs always give the same
 * spec, so a render is reproducible for `specialistEntryIsCurrent`.
 */
export function specialistRoleSpec(options: {
  readonly stage: Stage;
  readonly roleKey?: string | undefined;
  readonly artifactTools?: boolean | undefined;
}): SpecialistRoleSpec {
  const { stage, roleKey = PRIMARY_ROLE_KEY, artifactTools = false } = options;
  const tooling = specialistTooling({ stage, roleKey, artifactTools });
  return {
    tooling,
    toolImports: [
      ...(tooling.artifacts ? [ARTIFACTS_IMPORT] : []),
      ...(tooling.deck ? [DECK_IMPORT] : []),
      ...(tooling.posix ? [POSIX_IMPORT] : []),
      ...(tooling.delivery ? [DELIVER_IMPORT] : []),
    ],
    artifactKind: STAGE_ARTIFACT_KIND[stage],
    promptNotes: tooling.artifacts ? [stageDocumentNote(stage, STAGE_ARTIFACT_KIND[stage])] : [],
    credentialPackage: artifactTools ? "@corbits/artifacts/sidecar-bundle" : null,
  };
}

/** The entry module path every specialist package ships, same convention as
 *  the lifecycle's `LIFECYCLE_ENTRY_PATH`. */
export const SPECIALIST_ENTRY_PATH = "workflow.js";

/** `sb-stage-<N>`: this specialist's workflow id, and the stem of the mail
 *  label its trigger declares (grant configuration only — the hub mints the
 *  real run address at deploy time; see `specialistEntrySource`'s doc). */
export function specialistWorkflowId(stage: Stage): string {
  return `sb-stage-${stage}`;
}

/**
 * What a rendered entry depends on: the stage, the model pin, the role and
 * its key, and whether it carries the artifact tools. Nothing of the
 * project's (#41 step 5): the same role renders the same entry for every
 * project, and what is the project's -- the tenant a record lands in, who a
 * package is for -- arrives with the run and the work.
 */
export type SpecialistSourceOptions = {
  readonly stage: Stage;
  readonly source: InferenceSourcePin;
  /** The agent this deployment runs. Passed in rather than derived from
   *  `stage` here (`agentFor(stage)`) so a stage's other roles — the
   *  brief evaluator, the requirements author, a panel principal — can each
   *  render as their own deployment; `specialist-deploy.ts` still resolves
   *  the primary per-stage role via `agentFor(stage)` today. */
  readonly role: AgentRole;
  /** A short, filesystem/asset-name-safe key identifying `role` within its
   *  stage — folded into the deployed asset's name by `specialist-deploy.ts`
   *  (`specialistAssetName`) so each role gets its own asset. */
  readonly roleKey: string;
  /** CL-8719: carry the `@corbits/artifacts` sidecar tool bundle, its
   *  `credentialBindings` entry and the matching grant requirement, and tell
   *  the model to call `artifact_create`/`artifact_write`. Default false —
   *  with it false the rendered source is byte-for-byte what it was before
   *  #466. Off until a browser-driven deploy of a credential-bound
   *  specialist is proven; see `ensureStageAgent` in `apps/web/src/client.ts`. */
  readonly artifactTools?: boolean;
};

/**
 * A role's kit prompt has no runtime after render time to load a skill
 * from — an agent step's `systemPrompt` is a static string baked in here —
 * so the skill text rides along with it. `artifactTools` appends the rule
 * telling the model to call `artifact_create`/`artifact_write` — only when
 * it actually carries those tools.
 */
function renderedPrompt(role: AgentRole, artifactTools: boolean): string {
  const prompt = `${role.system}\n\n${skillTextFor(role)}`;
  return artifactTools ? `${prompt}\n\n${ARTIFACT_WRITE_RULE}` : prompt;
}

/**
 * The primary per-stage specialist's system prompt: its own kit role, and
 * nothing else. The brief evaluator (stage 1) and the requirements author
 * plus the four panel principals (stage 6) no longer fold in here as
 * reference sections — each becomes its own deployment, rendered against its
 * own `role`/`roleKey`, so folding their prompts in here too would run them
 * twice.
 */
function systemPromptForRole(role: AgentRole, artifactTools: boolean): string {
  return renderedPrompt(role, artifactTools);
}

/**
 * The entry module a stage specialist's workflow asset ships, as source: a
 * single-step, mail-triggered, unbounded-turn agent with `drainBehavior:
 * "wait"` and no `timeout` — the same shape `buildAgentDefinitionJson` in
 * `wb/apps/web/src/agent-deploy.ts` builds, so it stays armed across an
 * approval park instead of aborting a run waiting on a person. Which tools,
 * notes and bindings a deployment carries is `specialistRoleSpec`'s call;
 * this only renders it.
 */
export function specialistEntrySource(options: SpecialistSourceOptions): string {
  const { stage, source, role, roleKey, artifactTools = false } = options;
  const workflowId = specialistWorkflowId(stage);
  const triggerAddress = `${workflowId}@solutions-builder.local`;

  // Everything this role carries is its spec's (#41 step 1): the imports and
  // the tools handed to the agent come from it in order, so an entry never
  // imports a tool its closure lacks (`specialistTooling` decides both).
  const spec = specialistRoleSpec({ stage, roleKey, artifactTools });
  const toolImports = spec.toolImports.map((entry) => `${entry.lines.join("\n")}\n`).join("");
  const tools = spec.toolImports.map((entry) => entry.tool).join(", ");

  // CL-8719: a credential-bound stage specialist writes its draft as a real
  // artifact through `@corbits/artifacts`' agent tool bundle, against the
  // run-scoped mount `mountWorkflowArtifacts` puts on the hub
  // (`embed-hub/src/index.ts`). `credentialBindings` names the `hub` handle
  // it declares against a provider/credential the installer ensures at
  // deploy time (`installer/src/artifacts-credential.ts`) before this
  // asset's deployment id even exists, so both names are deterministic from
  // the role alone. Opt-in (`artifactTools`, default off) — see
  // `SpecialistSourceOptions`; today only stage 8 turns it on, and
  // `publish_workspace` resolves the same credential itself rather than
  // through the generic bundle, so stage 8 gets the binding without the
  // bundle or the rule telling the model to call `artifact_create`.
  const genericArtifactTools = spec.tooling.artifacts;
  const credentialName = workflowArtifactsCredentialName(role.id);

  let systemPrompt = systemPromptForRole(role, genericArtifactTools);
  for (const note of spec.promptNotes) {
    systemPrompt = `${systemPrompt}\n\n${note}`;
  }

  // `package` must match the consumer identity the sidecar's source-ref
  // lineage keys credential capabilities against: a specialist deploys as
  // `source` (not a pinned `tool-packages-manifest.json`), so
  // `workflow-substrate-factory.ts`'s `sourceTools` arm sets
  // `StepToolFactory.packageName` to the bundle's own `defineTool({ id })` --
  // `SIDECAR_BUNDLE_ID` in `@corbits/artifacts/sidecar-bundle.ts`, or (stage
  // 8) `publishWorkspaceTool`'s own `defineTool({ id })` in
  // `tools-delivery/publish-workspace.ts` -- not the bare npm package name
  // `reconcileDeclaredCredentials`/`toolConsumer` would expect from a pinned
  // closure. Binding against the bare name here builds a
  // `tool:@corbits/artifacts` (or `tool:@solutions-builder/tools-delivery`)
  // consumer that never matches the bundle's own consumer identity, so the
  // capability is never assembled and the tool's `resolve("credentials")`
  // fails closed.
  const credentialBindings = spec.credentialPackage
    ? `
  credentialBindings: [
    {
      package: ${JSON.stringify(spec.credentialPackage)},
      handle: "hub",
      provider: ${JSON.stringify(WORKFLOW_ARTIFACTS_PROVIDER_NAME)},
      name: ${JSON.stringify(credentialName)},
      locator: "tenant",
    },
  ],`
    : "";

  return `import { defineWorkflow, step } from "@intx/workflow/definition";
import { defineAgent } from "@intx/agent";
${toolImports}
const SOURCE = ${JSON.stringify(source)};

const AGENT = defineAgent({
  id: ${JSON.stringify(role.id)},
  systemPrompt: ${JSON.stringify(systemPrompt)},
  tools: [${tools}],
  capabilities: [],
  inference: { sources: [SOURCE] },
});

export default defineWorkflow({
  id: ${JSON.stringify(workflowId)},
  triggers: [{ type: "mail", to: ${JSON.stringify(triggerAddress)} }],${credentialBindings}
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
`;
}
