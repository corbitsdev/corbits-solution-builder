/**
 * A stage specialist as workflow source.
 *
 * Each `packages/specialist-*` role package authors a real `src/workflow.ts`
 * (`defineAgent` + `defineWorkflow` + mail trigger). `scripts/specialist-pack.ts`
 * compiles that to `workflow.js`; the installer copies those bytes and writes
 * `inference-source.js` beside them (the model pin, same idea as
 * `namer-source.js`). There is no string-built entry.
 *
 * There is no chat section, no router, no approve chain: a specialist only
 * ever answers the mail addressed to its own run, and a stage's approval is
 * a client-side artifact write, not a signal this workflow waits on.
 */
import type { ArtifactKind } from "./artifacts.js";
import type { Stage } from "./ledger.js";

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
 * The tools a specialist's packed entry imports, by stage: what the pushed
 * tree must ship as members and the package must depend on (#42). One place
 * decides, so an entry never imports a tool its closure lacks.
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
  readonly artifactTools?: boolean | undefined;
}): SpecialistTooling {
  const { stage, artifactTools = false } = options;
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

/** The entry module path every specialist package ships, same convention as
 *  the lifecycle's `LIFECYCLE_ENTRY_PATH`. */
export const SPECIALIST_ENTRY_PATH = "workflow.js";

/** The overlay the packed entry imports for its model pin. Written at deploy,
 *  never baked into `workflow.js`. */
export const SPECIALIST_INFERENCE_SOURCE_PATH = "inference-source.js";

/** `sb-stage-<N>`: this specialist's workflow id, and the stem of the mail
 *  label its trigger declares (grant configuration only — the hub mints the
 *  real run address at deploy time). */
export function specialistWorkflowId(stage: Stage): string {
  return `sb-stage-${stage}`;
}

/**
 * What a credential-bound deployment declares: the `hub` binding, and the
 * use-grant its run needs on exactly that credential. Interchange delivers
 * the bound credential's material but mints no `credential:<id>` / `use`
 * grant (#388), so the requirement is declared here, scoped to the package
 * the binding is for. Production `artifactTools` stays false; bindings are
 * not in the packed entry until a later per-package tools-on PR.
 */
export function credentialAccess(pkg: string, credentialName: string, credentialId: string) {
  return {
    credentialBindings: [
      { package: pkg, handle: "hub", provider: WORKFLOW_ARTIFACTS_PROVIDER_NAME, name: credentialName, locator: "tenant" },
    ],
    grantRequirements: [
      { resource: `credential:${credentialId}`, action: "use", source: "creator", conditions: { tool: `tool:${pkg}` } },
    ],
  };
}

/** The module `workflow.js` imports its inference pin from. */
export function inferenceSourceModule(pin: InferenceSourcePin): string {
  return `export default ${JSON.stringify(pin)};\n`;
}
