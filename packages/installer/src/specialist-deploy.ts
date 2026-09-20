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
import { ApiError, type Transport } from "@intx/hub-client";
import type { Stage } from "@solutions-builder/app/ledger";
import {
  ARTIFACT_TOOL_DEPENDENCIES,
  BUILD_STAGE,
  PACKAGE_STAGE,
  SPECIALIST_ENTRY_PATH,
  WORKFLOW_PACKAGE_DEPENDENCIES,
  specialistEntrySource,
  type InferenceSourcePin,
} from "@solutions-builder/app/specialist-source";
import { ensureWorkflowArtifactsCredential } from "./artifacts-credential.js";
import { assetsFor, catalogFor, getTenant, workflowsFor, type HubDeployment } from "./hub.js";
import { readProject } from "./project-tenant.js";
import {
  appMemberFiles,
  artifactsMemberFiles,
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
  waitForPushVisible,
  type ClosureSource,
  type SidecarCapability,
  type WorkflowGitPush,
} from "./workflow-deploy.js";

/** The specialist member inside its asset; the vendored closures sit beside it,
 *  the same layout `workflow-deploy.ts`'s `LIFECYCLE_DIR` uses for the lifecycle. */
const SPECIALIST_DIR = "packages/specialist";
const DIGEST_PATH = "closure.sha256";

function normalizedProjectId(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** `sb-project-<projectId>-stage-<N>`, normalized the same way `lifecycleAssetName` is. */
function specialistAssetName(projectId: string, stage: Stage): string {
  return `sb-project-${normalizedProjectId(projectId)}-stage-${stage}`;
}

const SPECIALIST_ASSET_STAGE = /-stage-(\d+)$/;

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

/**
 * Picks one deployment out of several matching the same asset -- concurrent
 * `ensureSpecialistDeployment` callers can each see no deployment and each
 * deploy one, so every caller must resolve the same winner afterward: a live
 * (non-ended) deployment over an ended one, then the oldest `createdAt` --
 * the first one ever deployed for this asset, so a later duplicate never
 * displaces the address callers already have.
 */
function pickDeployment(deployments: readonly HubDeployment[]): HubDeployment | undefined {
  return [...deployments].sort((a, b) => {
    const aLive = !ENDED_DEPLOYMENT_STATUSES.has(a.status);
    const bLive = !ENDED_DEPLOYMENT_STATUSES.has(b.status);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  })[0];
}

export type SpecialistDeploymentRef = { readonly stage: Stage; readonly deploymentId: string };

/**
 * Every stage specialist deployed for `projectId`: workflow assets named
 * `sb-project-<projectId>-stage-<N>` in the workspace tenant, paired with
 * their live deployment by `definitionAssetId` -- the same pairing
 * `ensureSpecialistDeployment` itself relies on. A pending approval's
 * `runId` is the deployment id it was parked under (a specialist's mail
 * address is `<deploymentId>@<domain>`), so this is what turns "an approval
 * is pending" into "which project and stage asked."
 */
export async function listSpecialistDeployments(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
): Promise<SpecialistDeploymentRef[]> {
  const prefix = `sb-project-${normalizedProjectId(projectId)}-stage-`;
  const assets = await assetsFor(transport, workspaceTenantId).list("workflow");
  const stageByAssetId = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.name.startsWith(prefix)) continue;
    const match = SPECIALIST_ASSET_STAGE.exec(asset.name);
    if (match) stageByAssetId.set(asset.id, Number(match[1]));
  }
  if (stageByAssetId.size === 0) return [];
  const deployments = await workflowsFor(transport, workspaceTenantId).deployments();
  return deployments.flatMap((deployment) => {
    const stage = stageByAssetId.get(deployment.definitionAssetId);
    return stage === undefined ? [] : [{ stage: stage as Stage, deploymentId: deployment.id }];
  });
}

export type SpecialistDeployment = {
  readonly deploymentId: string;
  /** `<deploymentId>@<tenant.domain>`: mail sent here reaches the specialist's run. */
  readonly address: string;
};

export type SpecialistDeploymentStatus = SpecialistDeployment & { readonly status: string };

/**
 * Re-lists `projectId`'s stage-`stage` asset's deployments and picks the live
 * one (`pickDeployment`), without deploying anything -- CL-8654: two sessions
 * opening the same stage within milliseconds can each deploy, leaving one
 * deployment `released` and the other live for the same asset. A caller
 * holding an `ensureStageAgent` result from before that resolved uses this to
 * notice its memoised deployment id is no longer the live pick. Null when the
 * asset does not exist yet -- the specialist has never been deployed.
 */
export async function stageSpecialistStatus(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
): Promise<SpecialistDeploymentStatus | null> {
  const tenant = await getTenant(transport, workspaceTenantId);
  if (!tenant?.domain) return null;
  const assetName = specialistAssetName(projectId, stage);
  const assets = await assetsFor(transport, workspaceTenantId).list("workflow");
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) return null;
  const deployments = (await workflowsFor(transport, workspaceTenantId).deployments()).filter(
    (deployment) => deployment.definitionAssetId === asset.id,
  );
  const winner = pickDeployment(deployments);
  if (!winner) return null;
  return { deploymentId: winner.id, address: `${winner.id}@${tenant.domain}`, status: winner.status };
}

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
  artifactTools: boolean,
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
  // `@corbits/artifacts` and its `@standard-schema/spec` peer are only a real
  // dependency of this member when the rendered entry actually imports the
  // generic tool bundle -- with `artifactTools` off, or on stage 8 (which
  // resolves its "hub" handle through `@solutions-builder/tools-delivery`
  // instead, see `specialistEntrySource`), dropping them keeps the deployed
  // package.json (and the closure below) the same shape it was pre-CL-8719.
  const needsGenericArtifactPackage = artifactTools && stage !== BUILD_STAGE;
  const dependencies = needsGenericArtifactPackage
    ? { ...WORKFLOW_PACKAGE_DEPENDENCIES, ...ARTIFACT_TOOL_DEPENDENCIES }
    : WORKFLOW_PACKAGE_DEPENDENCIES;
  const member = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
    interchange: { workflow: `./${SPECIALIST_ENTRY_PATH}` },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    [`${SPECIALIST_DIR}/package.json`]: `${JSON.stringify(member, null, 2)}\n`,
    [`${SPECIALIST_DIR}/${SPECIALIST_ENTRY_PATH}`]: specialistEntrySource({
      stage,
      source,
      projectId,
      assetName: name,
      artifactTools,
      ...(audiences ? { audiences } : {}),
    }),
    // The full closure, the same set the lifecycle ships: whichever tool a
    // given stage's specialist imports (deck, posix, delivery/deliver -- see
    // `specialistEntrySource`) resolves against a member that is always here.
    ...(await vendoredMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await appMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await toolsDeckMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await toolsDeliveryMemberFiles(closure.manifest, closure.fetchTarball)),
    // Only shipped when the rendered entry actually imports the generic
    // bundle -- stage 8 never does (see `needsGenericArtifactPackage` above).
    ...(needsGenericArtifactPackage ? await artifactsMemberFiles(closure.manifest, closure.fetchTarball) : {}),
  };
  files[DIGEST_PATH] = `${await treeDigest(files)}\n`;
  return files;
}

/**
 * Makes sure `projectId`'s stage-`stage` specialist has a live deployment.
 * When one already exists on this asset and is still live, hands it back
 * unchanged -- a specialist deploys once per stage per project, lazily.
 * Otherwise: create-or-find the `workflow`-kind asset
 * (`sb-project-<projectId>-stage-<N>`), push the rendered source with the
 * same push-token flow `workflow-deploy.ts`'s `pushWorkflowSourceTree` uses,
 * and deploy it against the tenant's offerings.
 *
 * Two browsers opening the same project's stage within seconds race every
 * step of this: `ensureWorkflowAsset` and the deploy re-checks already
 * absorb their own 409s, but a conflict can still surface from a step this
 * function does not itself retry (the git-push token mint, the deploy call).
 * `ensureSpecialistDeployment` below retries the whole thing once when that
 * happens, so the loser's request lands on the winner's result instead of
 * the hub's conflict error reaching the workspace.
 */
async function ensureSpecialistDeploymentOnce(
  transport: Transport,
  sidecar: SidecarCapability,
  closure: ClosureSource,
  gitPush: WorkflowGitPush,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
  hubOrigin: string,
  artifactTools: boolean,
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
  const matching = (deployments: readonly HubDeployment[]) =>
    deployments.filter((deployment) => deployment.definitionAssetId === assetId);
  const existing = pickDeployment(matching(await workflows.deployments()));
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

  const rendered = await renderSpecialistSource(closure, projectId, stage, source, artifactTools, audiences);
  const commitSha = await pushWorkflowSourceTree(
    transport,
    workspaceTenantId,
    assetId,
    assetName,
    { ...rendered },
    `Deploy stage ${stage} specialist`,
    gitPush,
  );

  // The hub's deploy path re-resolves this asset's default ref fresh at
  // closure-delivery time rather than reusing `commitSha` above; on a race
  // with the push's own ref update it can pack a pre-push state and the
  // sidecar's pinned subtree read fails (`git.materialization.failed`).
  // Wait for the pushed digest to read back through the hub's own blob
  // route -- the same read path the deploy uses -- before deploying.
  await waitForPushVisible(transport, workspaceTenantId, assetId, DIGEST_PATH, rendered[DIGEST_PATH]!);

  // Rendering and pushing the source above takes long enough for a
  // concurrent caller to have deployed onto this asset meanwhile; re-check
  // once more right before deploying so we don't create a second live
  // deployment for the same asset.
  const justDeployed = pickDeployment(matching(await workflows.deployments()));
  if (justDeployed && (await deploymentIsLive(transport, workspaceTenantId, justDeployed.id))) {
    return { deploymentId: justDeployed.id, address: `${justDeployed.id}@${tenant.domain}` };
  }

  const offeringIds = offerings.map((offering) => offering.id);
  const deployment = await workflows.deploy({
    source: { kind: "asset", assetId, package: { format: "source", commitSha, packageName: assetName } },
    entry: `./${SPECIALIST_ENTRY_PATH}`,
    sourceOfferingIds: offeringIds,
    defaultSourceOfferingId: offeringIds[0]!,
  });

  // A concurrent caller may have deployed onto this asset in the meantime;
  // re-resolve so every caller lands on the same, deterministically-chosen
  // deployment rather than each keeping the one it happened to create.
  const winner = pickDeployment(matching(await workflows.deployments())) ?? deployment;

  // CL-8719: the credential the winning deployment's `credentialBindings`
  // names must exist -- and be scoped to the winning anchor run -- before
  // its first mail trigger launches it. Only reached on an actual (re)deploy,
  // never the early "already live" returns above: rotating the secret here
  // would break an in-flight tool call against a still-live prior deployment.
  // Skipped entirely when `artifactTools` is off -- the rendered source
  // carries no `credentialBindings` to satisfy, so minting one is dead work.
  if (artifactTools) {
    await ensureWorkflowArtifactsCredential(transport, workspaceTenantId, hubOrigin, assetName, winner.id);
  }

  return { deploymentId: winner.id, address: `${winner.id}@${tenant.domain}` };
}

export async function ensureSpecialistDeployment(
  transport: Transport,
  sidecar: SidecarCapability,
  closure: ClosureSource,
  gitPush: WorkflowGitPush,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
  hubOrigin: string,
  /** CL-8719: opt-in, default off -- see `specialist-source.ts`'s
   *  `SpecialistSourceOptions.artifactTools`. */
  artifactTools = false,
): Promise<SpecialistDeployment> {
  const attempt = () =>
    ensureSpecialistDeploymentOnce(
      transport,
      sidecar,
      closure,
      gitPush,
      workspaceTenantId,
      projectId,
      stage,
      hubOrigin,
      artifactTools,
    );
  try {
    return await attempt();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return await attempt();
    throw cause;
  }
}
