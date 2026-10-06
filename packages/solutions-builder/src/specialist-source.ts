/**
 * A stage specialist as workflow source.
 *
 * Each `packages/specialist-*` role package authors a real `src/workflow.ts`
 * (`defineAgent` + `defineWorkflow` + mail trigger). `scripts/specialist-pack.ts`
 * compiles that to `workflow.js`; the installer copies those bytes and writes
 * `inference-source.js` (the model pin, same idea as `namer-source.js`) and
 * `workspace-guidance.js` beside them. There is no string-built entry.
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
 * The tools a specialist ships: what the pushed tree must carry as members and
 * the package must depend on (#42). The role package's own `package.json`
 * decides by what it declares, as any Interchange package does; the pack
 * carries those declarations beside `workflow.js` (`PackedSpecialist`).
 */
export type SpecialistTooling = {
  /** `@solutions-builder/tools-deck`'s `render_deck`. No stage carries it (#435). */
  readonly deck: boolean;
  /** `@intx/tools-posix`: the shell. No stage carries it; the build runs on the host. */
  readonly posix: boolean;
  /** `@solutions-builder/tools-delivery`: stage 9's `deliver`. */
  readonly delivery: boolean;
  /** `@corbits/artifacts`' generic bundle. */
  readonly artifacts: boolean;
};

/** The tool packages a role package can declare. */
export const TOOL_PACKAGES: Readonly<Record<keyof SpecialistTooling, string>> = {
  deck: "@solutions-builder/tools-deck",
  posix: "@intx/tools-posix",
  delivery: "@solutions-builder/tools-delivery",
  artifacts: "@corbits/artifacts",
};

/** The tooling a role's declared dependencies name. */
export function specialistTooling(dependencies: readonly string[]): SpecialistTooling {
  return {
    deck: dependencies.includes(TOOL_PACKAGES.deck),
    posix: dependencies.includes(TOOL_PACKAGES.posix),
    delivery: dependencies.includes(TOOL_PACKAGES.delivery),
    artifacts: dependencies.includes(TOOL_PACKAGES.artifacts),
  };
}

/**
 * A role's specialist as the interface ships it: `scripts/specialist-pack.ts`
 * writes the compiled entry and the role package's declared dependencies under
 * `specialists/<roleId>/`, and the client fetches both to deploy it.
 */
export type PackedSpecialist = {
  readonly roleId: string;
  /** The compiled `workflow.js`. */
  readonly workflow: string;
  /** The role package's own `dependencies`, by name. */
  readonly dependencies: readonly string[];
};

/** Where the pack writes a role's declared dependencies, beside `workflow.js`. */
export const SPECIALIST_DEPENDENCIES_PATH = "dependencies.json";

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

/** The overlay the packed entry imports for the workspace's language and
 *  design guidance, set between its role text and its skills. Written at
 *  deploy, like the pin. */
export const SPECIALIST_GUIDANCE_PATH = "workspace-guidance.js";

/**
 * What a credential-bound deployment declares: the `hub` binding, and the
 * use-grant its run needs on exactly that credential. Interchange delivers
 * the bound credential's material but mints no `credential:<id>` / `use`
 * grant (#388), so the requirement is declared here, scoped to the package
 * the binding is for. No packed entry carries a binding yet; a package that
 * imports `@corbits/artifacts` declares this itself in a later tools-on PR.
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

/** A deploy-time module `workflow.js` imports a value from: the inference pin
 *  (`SPECIALIST_INFERENCE_SOURCE_PATH`) or the workspace guidance
 *  (`SPECIALIST_GUIDANCE_PATH`). */
export function defaultExportModule(value: InferenceSourcePin | string): string {
  return `export default ${JSON.stringify(value)};\n`;
}
