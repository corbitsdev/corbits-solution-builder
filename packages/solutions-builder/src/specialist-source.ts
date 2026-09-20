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
import { agentById, agentFor, panelPrincipals, type AgentRole } from "./kit.js";
import type { Stage } from "./ledger.js";
import { skillTextFor } from "./seed-kit.js";

/** CL-8719: the `http` provider every specialist's `@corbits/artifacts/sidecar-bundle`
 *  resolves its `hub` credential handle against; one row per workspace, its
 *  `apiBaseUrl` the hub's own origin (see `installer/src/artifacts-credential.ts`). */
export const WORKFLOW_ARTIFACTS_PROVIDER_NAME = "sb-workflow-artifacts";

/** The credential name a specialist asset's `credentialBindings` names — known
 *  before the asset is even deployed, since it derives only from the asset's
 *  own (deterministic) name, never its deployment id. */
export function workflowArtifactsCredentialName(assetName: string): string {
  return `workflow-artifacts:${assetName}`;
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

/** The stage whose rounds run the build agent. */
export const BUILD_STAGE = 8;

/** The stage whose rounds write one package per stakeholder, each behind its own gate. */
export const PACKAGE_STAGE = 5;

/** The stage whose specialist checks a delivery manifest. */
export const DELIVERY_STAGE = 9;

/**
 * What the deployed package depends on. `@intx/workflow` is a workspace member
 * of the asset (the vendored revision, shipped beside the workflow by
 * `packages/installer/src/workflow-closure.ts`); everything else comes from
 * npm. `hono` is imported by nothing here: it satisfies the peer dependency
 * `@logtape/hono` declares inside `@intx/log`, which the closure resolver
 * refuses to leave unmet. `@solutions-builder/tools-deck` is the
 * deck-rendering tool stage 5's specialist carries: it ships beside the
 * workflow the same way `@intx/tools-posix` does, so a running workflow
 * renders a stakeholder's slides itself instead of asking the hub to do it.
 * `@solutions-builder/tools-delivery` is the same shape for stage 9's
 * delivery-verifier: it summarizes a manifest's already-checked descriptors
 * into a completeness report without a hub round trip.
 */
export const WORKFLOW_PACKAGE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/workflow": "workspace:*",
  "@intx/agent": "workspace:*",
  "@intx/tools-posix": "workspace:*",
  "@solutions-builder/app": "workspace:*",
  "@solutions-builder/tools-deck": "workspace:*",
  "@solutions-builder/tools-delivery": "workspace:*",
  // CL-8719: every stage specialist's `artifacts` tool, shipped as a
  // workspace member the same way `@solutions-builder/tools-deck` is
  // (`installer/src/workflow-closure.ts`'s `artifactsMemberFiles`) -- not a
  // real npm/git dependency. A deployed specialist's own `bun install` never
  // reaches the network for a `workspace:*` member; it only does for a real
  // registry spec (`hono` below), and `@corbits/artifacts` is not published
  // to the npm registry.
  "@corbits/artifacts": "workspace:*",
  // `@hono/standard-validator` (a real dependency of `@corbits/artifacts`
  // itself, resolved from the real npm registry the same way `hono` is)
  // declares this as a peer; a deployed workspace's own dependency
  // resolution needs it present at the top level to satisfy that peer.
  "@standard-schema/spec": "^1.0.0",
  hono: "^4.0.0",
};

/** The entry module path every specialist package ships, same convention as
 *  the lifecycle's `LIFECYCLE_ENTRY_PATH`. */
export const SPECIALIST_ENTRY_PATH = "workflow.js";

/** `sb-stage-<N>`: this specialist's workflow id, and the stem of the mail
 *  label its trigger declares (grant configuration only — the hub mints the
 *  real run address at deploy time; see `specialistEntrySource`'s doc). */
export function specialistWorkflowId(stage: Stage): string {
  return `sb-stage-${stage}`;
}

export type SpecialistSourceOptions = {
  readonly stage: Stage;
  readonly source: InferenceSourcePin;
  readonly projectId: string;
  /** This asset's deterministic name (`sb-project-<projectId>-stage-<N>`),
   *  passed in rather than recomputed here since `specialist-deploy.ts`
   *  already owns that naming — used only to name the credential binding. */
  readonly assetName: string;
  /** The project's audience packages, in stage 5 fan-out order — folded into
   *  a stage-5 specialist's prompt as a reference section so it knows who
   *  each package is for. Stage 5's fan-out itself stays client-side: each
   *  round is its own mail turn, not a step this workflow branches on. */
  readonly audiences?: readonly { readonly name: string; readonly role: string }[];
};

/**
 * A role's kit prompt has no runtime after render time to load a skill
 * from — an agent step's `systemPrompt` is a static string baked in here —
 * so the skill text rides
 * along with it.
 */
function renderedPrompt(role: AgentRole): string {
  return `${role.system}\n\n${skillTextFor(role)}`;
}

/**
 * A stage's specialist system prompt: its own kit role, plus whatever other
 * kit roles the lifecycle used to chain into that stage as separate steps.
 * There is only one step now, so those roles fold in as reference sections
 * instead: stage 1 folds in the brief evaluator's rubric (`EVALUATE_STEP_ID`
 * no longer exists as its own step), and stage 6 folds in the requirements
 * author and the four panel principals (no separate requirements/plan/review
 * chain either).
 */
function systemPromptForStage(stage: Stage): string {
  const prompt = renderedPrompt(agentFor(stage));
  if (stage === 1) {
    const evaluator = agentById("brief-evaluator");
    if (!evaluator) throw new Error("brief-evaluator role missing from the kit");
    return `${prompt}\n\n## Brief evaluator rubric\n\n${evaluator.system}`;
  }
  if (stage === 6) {
    const author = agentById("requirements-author");
    if (!author) throw new Error("requirements-author role missing from the kit");
    const sections = [`## Requirements author reference\n\n${author.system}`];
    for (const principal of panelPrincipals()) {
      sections.push(`## Panel: ${principal.title} review\n\n${principal.system}`);
    }
    return `${prompt}\n\n${sections.join("\n\n")}`;
  }
  return prompt;
}

/** The audience packages, folded into a stage-5 specialist's prompt as a
 *  reference section. */
function audienceSection(audiences: readonly { readonly name: string; readonly role: string }[]): string {
  const lines = audiences.map((audience) => `- ${audience.name} (${audience.role})`);
  return `## Audiences\n\nWrite one package per audience below, in order.\n\n${lines.join("\n")}`;
}

/**
 * The entry module a stage specialist's workflow asset ships, as source: a
 * single-step, mail-triggered, unbounded-turn agent with `drainBehavior:
 * "wait"` and no `timeout` — the same shape `buildAgentDefinitionJson` in
 * `wb/apps/web/src/agent-deploy.ts` builds, so it stays armed across an
 * approval park instead of aborting a run waiting on a person. Stage 5's
 * specialist carries the deck-rendering tool, stage 8's carries posix, and
 * stage 9's carries the delivery-status and deliver tools; every other stage
 * carries none.
 */
export function specialistEntrySource(options: SpecialistSourceOptions): string {
  const { stage, source, audiences, projectId, assetName } = options;
  const workflowId = specialistWorkflowId(stage);
  const triggerAddress = `${workflowId}@solutions-builder.local`;
  const role = agentFor(stage);
  const kind = STAGE_ARTIFACT_KIND[stage];

  const stageToolImports =
    stage === PACKAGE_STAGE
      ? `import { deck } from ${JSON.stringify("@solutions-builder/tools-deck/sidecar-bundle")};\n`
      : stage === BUILD_STAGE
        ? `import { posix } from ${JSON.stringify("@intx/tools-posix/sidecar-bundle")};\nimport { publishWorkspace } from ${JSON.stringify("@solutions-builder/tools-delivery/publish-workspace")};\n`
        : stage === DELIVERY_STAGE
          ? `import { delivery, deliver } from ${JSON.stringify("@solutions-builder/tools-delivery/sidecar-bundle")};\n`
          : "";
  const stageTools =
    stage === PACKAGE_STAGE
      ? "deck, "
      : stage === BUILD_STAGE
        ? "posix, publishWorkspace, "
        : stage === DELIVERY_STAGE
          ? "delivery, deliver, "
          : "";

  // CL-8719: every stage specialist writes its draft as a real artifact
  // through `@corbits/artifacts`' agent tool bundle, against the run-scoped
  // mount `mountWorkflowArtifacts` puts on the hub (`embed-hub/src/index.ts`).
  // `credentialBindings` names the `hub` handle it declares against a
  // provider/credential the installer ensures at deploy time
  // (`installer/src/artifacts-credential.ts`) before this asset's deployment
  // id even exists, so both names are deterministic from `assetName` alone.
  const toolImports = `import { artifacts } from ${JSON.stringify("@corbits/artifacts/sidecar-bundle")};\n${stageToolImports}`;
  const tools = `artifacts, ${stageTools}`;
  const credentialName = workflowArtifactsCredentialName(assetName);

  let systemPrompt = systemPromptForStage(stage);
  systemPrompt = `${systemPrompt}\n\n## Artifact context\n\nprojectId: ${projectId}\nstage: ${stage}\nkind: ${kind}`;
  if (stage === PACKAGE_STAGE && audiences && audiences.length > 0) {
    systemPrompt = `${systemPrompt}\n\n${audienceSection(audiences)}`;
  }

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
  triggers: [{ type: "mail", to: ${JSON.stringify(triggerAddress)} }],
  credentialBindings: [
    {
      package: ${JSON.stringify("@corbits/artifacts")},
      handle: "hub",
      provider: ${JSON.stringify(WORKFLOW_ARTIFACTS_PROVIDER_NAME)},
      name: ${JSON.stringify(credentialName)},
      locator: "tenant",
    },
  ],
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
