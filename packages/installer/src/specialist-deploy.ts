/**
 * A stage specialist as a hub deployment.
 *
 * Mirrors `workflow-deploy.ts`'s lifecycle deploy, but for the single-step,
 * mail-triggered, unbounded-turn shape `@solutions-builder/app/specialist-source`
 * renders (the shape `wb/apps/web/src/agent-deploy.ts` deploys every
 * workbench agent as): one asset, one push, one deployment, per project per
 * stage, deployed lazily the first time a project's stage is opened. There is
 * no chat section and no approve chain here -- a specialist's run address is
 * mailed to directly, and the person's approval is a client-side artifact
 * write, not a signal this deploy waits on.
 */
import type { Transport } from "@intx/hub-client";
import type { Stage } from "@solutions-builder/app/ledger";
import {
  PACKAGE_STAGE,
  SPECIALIST_ENTRY_PATH,
  WORKFLOW_PACKAGE_DEPENDENCIES,
  specialistEntrySource,
  type InferenceSourcePin,
} from "@solutions-builder/app/specialist-source";
import { catalogFor, getTenant, workflowsFor } from "./hub.js";
import { readProject } from "./project-tenant.js";
import {
  appMemberFiles,
  toolsDeckMemberFiles,
  toolsDeliveryMemberFiles,
  treeDigest,
  vendoredMemberFiles,
} from "./workflow-closure.js";
import {
  deploymentIsLive,
  ensureWorkflowAsset,
  pushWorkflowSourceTree,
  sourceFor,
  type ClosureSource,
  type SidecarCapability,
  type WorkflowGitPush,
} from "./workflow-deploy.js";

/** The specialist member inside its asset; the vendored closures sit beside it,
 *  the same layout `workflow-deploy.ts`'s `LIFECYCLE_DIR` uses for the lifecycle. */
const SPECIALIST_DIR = "packages/specialist";
const DIGEST_PATH = "closure.sha256";

/** `sb-project-<projectId>-stage-<N>`, normalized the same way `lifecycleAssetName` is. */
function specialistAssetName(projectId: string, stage: Stage): string {
  return `sb-project-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-stage-${stage}`;
}

export type SpecialistDeployment = {
  readonly deploymentId: string;
  /** `<deploymentId>@<tenant.domain>`: mail sent here reaches the specialist's run. */
  readonly address: string;
};

/**
 * The asset a stage specialist deploys into: the same package-tree shape
 * `workflow-deploy.ts`'s `renderLifecycleSource` builds for the lifecycle --
 * a root workspace `package.json`, a member whose `interchange.workflow`
 * points at the rendered entry, and the vendored `@intx`/`@solutions-builder`
 * closures beside it -- but with `specialistEntrySource` as the entry and no
 * `actions.js`: a specialist has no `routeMessage` action to wire and no loop
 * body to carry it into.
 */
async function renderSpecialistSource(
  closure: ClosureSource,
  projectId: string,
  stage: Stage,
  source: InferenceSourcePin,
  audiences?: readonly { readonly name: string; readonly role: string }[],
): Promise<Record<string, string>> {
  const name = specialistAssetName(projectId, stage);
  const root = {
    name: `${name}-workspace`,
    version: "0.0.0",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
    catalog: closure.manifest.catalog,
  };
  const member = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: WORKFLOW_PACKAGE_DEPENDENCIES,
    interchange: { workflow: `./${SPECIALIST_ENTRY_PATH}` },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    [`${SPECIALIST_DIR}/package.json`]: `${JSON.stringify(member, null, 2)}\n`,
    [`${SPECIALIST_DIR}/${SPECIALIST_ENTRY_PATH}`]: specialistEntrySource({
      stage,
      source,
      ...(audiences ? { audiences } : {}),
    }),
    // The full closure, the same set the lifecycle ships: whichever tool a
    // given stage's specialist imports (deck, posix, delivery/deliver -- see
    // `specialistEntrySource`) resolves against a member that is always here.
    ...(await vendoredMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await appMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await toolsDeckMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await toolsDeliveryMemberFiles(closure.manifest, closure.fetchTarball)),
  };
  files[DIGEST_PATH] = `${await treeDigest(files)}\n`;
  return files;
}

/**
 * Makes sure `projectId`'s stage-`stage` specialist has a live deployment.
 * When one already exists on this asset and is still live, hands it back
 * unchanged -- a specialist deploys once per stage per project, lazily, not
 * on every reconcile the way the lifecycle redeploys on a changed digest.
 * Otherwise: create-or-find the `workflow`-kind asset
 * (`sb-project-<projectId>-stage-<N>`, exactly like `workflow-deploy.ts`'s
 * `lifecycleAsset`), push the rendered source with the same push-token flow,
 * and deploy it against the tenant's offerings the same way
 * `ensureLifecycleDeployment` resolves them.
 */
export async function ensureSpecialistDeployment(
  transport: Transport,
  sidecar: SidecarCapability,
  closure: ClosureSource,
  gitPush: WorkflowGitPush,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
): Promise<SpecialistDeployment> {
  if (!sidecar.canPlaceSidecars) {
    throw new Error("no host is placing sidecars; cannot deploy a stage specialist");
  }

  const tenant = await getTenant(transport, workspaceTenantId);
  if (!tenant?.domain) {
    throw new Error("the workspace tenant has no domain to address a specialist at");
  }

  const assetName = specialistAssetName(projectId, stage);
  const assetId = await ensureWorkflowAsset(transport, workspaceTenantId, assetName, `Stage ${stage} specialist`);

  const workflows = workflowsFor(transport, workspaceTenantId);
  const existing = (await workflows.deployments()).find((deployment) => deployment.definitionAssetId === assetId);
  if (existing && (await deploymentIsLive(transport, workspaceTenantId, existing.id))) {
    return { deploymentId: existing.id, address: `${existing.id}@${tenant.domain}` };
  }

  const catalog = catalogFor(transport, workspaceTenantId);
  const offerings = (await catalog.offerings())
    .filter((offering) => !offering.disabled)
    .sort((a, b) => a.priority - b.priority);
  if (offerings.length === 0) {
    throw new Error("connect a model provider before deploying a stage specialist");
  }
  const source = await sourceFor(transport, workspaceTenantId, offerings[0]!);
  if (!source) {
    throw new Error("the tenant's offering does not resolve to a known model");
  }

  // Only stage 5's specialist reads a project's audiences; every other
  // stage's prompt is stage-fixed and needs no project read at all.
  const project = stage === PACKAGE_STAGE ? await readProject(transport, projectId) : null;
  const audiences = project?.policy.audiences;

  const rendered = await renderSpecialistSource(closure, projectId, stage, source, audiences);
  const commitSha = await pushWorkflowSourceTree(
    transport,
    workspaceTenantId,
    assetId,
    assetName,
    { ...rendered },
    `Deploy stage ${stage} specialist`,
    gitPush,
  );

  const offeringIds = offerings.map((offering) => offering.id);
  const deployment = await workflows.deploy({
    source: { kind: "asset", assetId, package: { format: "source", commitSha, packageName: assetName } },
    entry: `./${SPECIALIST_ENTRY_PATH}`,
    sourceOfferingIds: offeringIds,
    defaultSourceOfferingId: offeringIds[0]!,
  });

  return { deploymentId: deployment.id, address: `${deployment.id}@${tenant.domain}` };
}
