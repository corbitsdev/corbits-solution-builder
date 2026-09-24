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
import { agentFor, type AgentRole } from "@solutions-builder/app/kit";
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
import { assetsFor, catalogFor, getTenant, readWorkflowSourceBlob, workflowsFor, type HubDeployment } from "./hub.js";
import { readProject, readStageSwitch, writeStageSwitch } from "./project-tenant.js";
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
/** The offering this asset was last deployed against -- written alongside the
 *  rendered source so `stageSpecialistSource` can report what a specialist is
 *  actually running on, rather than the tenant's current catalog order.
 *  CL-8783 verdict: this pin is a reporting artifact only, NOT the deploy
 *  path -- the hub resolves the inference chain at deploy time from
 *  `sourceOfferingIds` (`resolveSourcesByOfferingIds`, the workflow-deploy
 *  path), never from this file. Removing it is deferred to the full slice. */
const SOURCE_PIN_PATH = `${SPECIALIST_DIR}/source.json`;

function normalizedProjectId(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** The role key naming the primary per-stage agent -- the only one deployed
 *  today. Keeping its asset name suffix-free is what keeps every already
 *  deployed specialist's name byte-identical across this change. */
const DEFAULT_ROLE_KEY = "primary";

/** `sb-project-<projectId>-stage-<N>`, normalized the same way `lifecycleAssetName`
 *  is, with `-<roleKey>` appended for any role other than the primary
 *  per-stage agent (`DEFAULT_ROLE_KEY`) -- so a stage's other roles (a brief
 *  evaluator, a requirements author, a panel principal) each get their own
 *  asset without disturbing the primary agent's existing name. */
function specialistAssetName(projectId: string, stage: Stage, roleKey: string = DEFAULT_ROLE_KEY): string {
  const base = `sb-project-${normalizedProjectId(projectId)}-stage-${stage}`;
  return roleKey === DEFAULT_ROLE_KEY ? base : `${base}-${roleKey}`;
}

/** Matches a role's asset name suffix -- `-stage-<N>` for the primary agent
 *  (`DEFAULT_ROLE_KEY`), `-stage-<N>-<roleKey>` for any other role. */
function specialistAssetStagePattern(roleKey: string): RegExp {
  const suffix = roleKey === DEFAULT_ROLE_KEY ? "" : `-${roleKey}`;
  return new RegExp(`-stage-(\\d+)${suffix}$`);
}

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

/**
 * Picks one deployment out of several matching the same asset -- concurrent
 * `ensureSpecialistDeployment` callers can each see no deployment and each
 * deploy one, so every caller must resolve the same winner afterward: a live
 * (non-ended) deployment over an ended one, then the oldest `createdAt` --
 * the first one ever deployed for this asset, so a later duplicate never
 * displaces the address callers already have.
 *
 * This is the DEFAULT resolution, not the whole story once CL-8899's
 * "switch model" exists: `resolveLiveDeployment` below layers the durable,
 * explicit switch target over this, and every caller that means "the
 * deployment mail should route to right now" (`stageSpecialistStatus`,
 * `ensureSpecialistDeploymentOnce`'s own existing-check) goes through that,
 * not this function directly. This stays oldest-wins so a restart-driven
 * replacement deployment -- which never touches the switch record -- is
 * picked exactly as it always was, with no special-casing for CL-8899 at
 * this layer at all.
 */
function pickDeployment(deployments: readonly HubDeployment[]): HubDeployment | undefined {
  return [...deployments].sort((a, b) => {
    const aLive = !ENDED_DEPLOYMENT_STATUSES.has(a.status);
    const bLive = !ENDED_DEPLOYMENT_STATUSES.has(b.status);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  })[0];
}

/**
 * CL-8899 "Switch model": the deployment this asset's mail should actually
 * route to. Prefers the project tenant's durably-recorded explicit switch
 * target (`StageModelSwitchRecord`, `project-tenant.ts`) while it is still
 * live; otherwise falls back to the default `pickDeployment` (oldest-wins).
 *
 * The switch record is written ONLY by `switchSpecialistDeployment` below,
 * on a person's explicit choice -- never by an ordinary deploy, and never by
 * a restart-driven replacement. So once a switch's target deployment ends
 * (the hub replaces it for any reason, including a restart recovery), this
 * silently reverts to oldest-wins exactly as if no switch had ever happened
 * -- a restart never "redirects" an active session onto stale switch
 * intent, because nothing here treats a dead switch target as special.
 */
async function resolveLiveDeployment(
  transport: Transport,
  projectId: string,
  stage: Stage,
  deployments: readonly HubDeployment[],
): Promise<HubDeployment | undefined> {
  const switched = await readStageSwitch(transport, projectId, stage);
  if (switched) {
    const target = deployments.find((deployment) => deployment.id === switched.deploymentId);
    if (target && !ENDED_DEPLOYMENT_STATUSES.has(target.status)) return target;
  }
  return pickDeployment(deployments);
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
  roleKey: string = DEFAULT_ROLE_KEY,
): Promise<SpecialistDeploymentRef[]> {
  const prefix = `sb-project-${normalizedProjectId(projectId)}-stage-`;
  const stagePattern = specialistAssetStagePattern(roleKey);
  const assets = await assetsFor(transport, workspaceTenantId).list("workflow");
  const stageByAssetId = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.name.startsWith(prefix)) continue;
    const match = stagePattern.exec(asset.name);
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
 * Every address `projectId`'s stage-`stage` specialist asset has ever been
 * deployed to -- unlike `stageSpecialistStatus`, this does NOT narrow to the
 * live pick (`pickDeployment`): a released or failed deployment's address
 * still received mail while it was live, and that mail is part of the
 * stage's conversation (CL-8927; also what CL-8899's "switch model" hand-off
 * needs to tell a fresh, history-less deployment from a genuinely new
 * stage). A caller merges reads across the whole list; a send still goes to
 * the current live address alone (`stageSpecialistStatus`). Empty when the
 * asset does not exist yet or the tenant has no domain.
 */
export async function stageSpecialistAddresses(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
  roleKey: string = DEFAULT_ROLE_KEY,
): Promise<string[]> {
  const tenant = await getTenant(transport, workspaceTenantId);
  if (!tenant?.domain) return [];
  const assetName = specialistAssetName(projectId, stage, roleKey);
  const assets = await assetsFor(transport, workspaceTenantId).list("workflow");
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) return [];
  const deployments = (await workflowsFor(transport, workspaceTenantId).deployments()).filter(
    (deployment) => deployment.definitionAssetId === asset.id,
  );
  return deployments.map((deployment) => `${deployment.id}@${tenant.domain}`);
}

/**
 * Re-lists `projectId`'s stage-`stage` asset's deployments and picks the live
 * one (`resolveLiveDeployment` -- an explicit switch target while live, else
 * `pickDeployment`'s oldest-wins), without deploying anything -- CL-8654: two
 * sessions opening the same stage within milliseconds can each deploy,
 * leaving one deployment `released` and the other live for the same asset. A
 * caller holding an `ensureStageAgent` result from before that resolved uses
 * this to notice its memoised deployment id is no longer the live pick. Null
 * when the asset does not exist yet -- the specialist has never been
 * deployed.
 */
export async function stageSpecialistStatus(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
  roleKey: string = DEFAULT_ROLE_KEY,
): Promise<SpecialistDeploymentStatus | null> {
  const tenant = await getTenant(transport, workspaceTenantId);
  if (!tenant?.domain) return null;
  const assetName = specialistAssetName(projectId, stage, roleKey);
  const assets = await assetsFor(transport, workspaceTenantId).list("workflow");
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) return null;
  const deployments = (await workflowsFor(transport, workspaceTenantId).deployments()).filter(
    (deployment) => deployment.definitionAssetId === asset.id,
  );
  const winner = await resolveLiveDeployment(transport, projectId, stage, deployments);
  if (!winner) return null;
  return { deploymentId: winner.id, address: `${winner.id}@${tenant.domain}`, status: winner.status };
}

/**
 * What `projectId`'s stage-`stage` specialist is actually deployed against --
 * the `(provider plugin, canonical model)` pin `ensureSpecialistDeploymentOnce`
 * resolved and wrote to `SOURCE_PIN_PATH` the last time this asset deployed,
 * read back off the asset's own tree rather than recomputed from the
 * tenant's current catalog order (which can have moved since). Null when the
 * asset does not exist yet, or predates this pin file.
 *
 * CL-8783 verdict: read-only reporting. The hub never reads this file when
 * deploying -- the inference chain comes from the deploy's `sourceOfferingIds`
 * via `resolveSourcesByOfferingIds` -- so this stays until the full slice
 * replaces pin reporting with declared `modelRequirements`.
 */
export async function stageSpecialistSourcePin(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
  roleKey: string = DEFAULT_ROLE_KEY,
): Promise<InferenceSourcePin | null> {
  const assetName = specialistAssetName(projectId, stage, roleKey);
  const assets = await assetsFor(transport, workspaceTenantId).list("workflow");
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) return null;
  const raw = await readWorkflowSourceBlob(transport, workspaceTenantId, asset.id, SOURCE_PIN_PATH);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as InferenceSourcePin).provider === "string" &&
      typeof (parsed as InferenceSourcePin).model === "string"
    ) {
      return parsed as InferenceSourcePin;
    }
    return null;
  } catch {
    return null;
  }
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
  roleKey: string,
  role: AgentRole,
  audiences?: readonly { readonly name: string; readonly role: string }[],
): Promise<Record<string, string>> {
  const name = specialistAssetName(projectId, stage, roleKey);
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
      role,
      roleKey,
      artifactTools,
      ...(audiences ? { audiences } : {}),
    }),
    // CL-8783 verdict: the pin rides along as a reporting artifact only. The
    // deployed entry resolves its model from the hub-resolved inference chain
    // (`sourceOfferingIds` -> `resolveSourcesByOfferingIds`), never by reading
    // this file back -- so a future slice can declare `modelRequirements` and
    // drop this pin without changing what the specialist runs on.
    [SOURCE_PIN_PATH]: `${JSON.stringify(source, null, 2)}\n`,
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
  roleKey: string,
  role: AgentRole,
  /** CL-8899 "Switch model": when set, names the offering the new deployment
   *  must lead with, and forces a fresh deploy even though a live deployment
   *  already exists on this asset -- the two early "already live" returns
   *  below both skip when this is set. Undefined for every existing caller,
   *  which keeps their deploy-once-per-asset behavior unchanged. */
  switchToOfferingId: string | undefined,
): Promise<SpecialistDeployment> {
  if (!sidecar.canPlaceSidecars) {
    throw new Error("no host is placing sidecars; cannot deploy a stage specialist");
  }

  const tenant = await getTenant(transport, workspaceTenantId);
  if (!tenant?.domain) {
    throw new Error("the workspace tenant has no domain to address a specialist at");
  }

  const assetName = specialistAssetName(projectId, stage, roleKey);
  const assetId = await ensureWorkflowAsset(transport, workspaceTenantId, assetName, `Stage ${stage} specialist`);

  const workflows = workflowsFor(transport, workspaceTenantId);
  const matching = (deployments: readonly HubDeployment[]) =>
    deployments.filter((deployment) => deployment.definitionAssetId === assetId);
  const existing = await resolveLiveDeployment(transport, projectId, stage, matching(await workflows.deployments()));
  if (!switchToOfferingId && existing && (await deploymentIsLive(transport, workspaceTenantId, existing.id))) {
    return { deploymentId: existing.id, address: `${existing.id}@${tenant.domain}` };
  }

  // CL-8783 verdict: `offerings[0]` picks only the installer's local render
  // pin (what `SOURCE_PIN_PATH` reports). The deploy below hands the FULL
  // ordered chain as `sourceOfferingIds`, and the hub re-resolves that chain
  // itself (`resolveSourcesByOfferingIds` in `workflow-allocation-service.ts`)
  // at provision and recovery time -- so a rotated credential (or visibility /
  // delegation re-check) is picked up without redeploying, and the pin here
  // never constrains what the specialist runs. A post-deploy priority reorder
  // still needs a redeploy (stored id order).
  const catalogOfferings = (await catalogFor(transport, workspaceTenantId).offerings())
    .filter((offering) => !offering.disabled)
    .sort((a, b) => a.priority - b.priority);
  if (catalogOfferings.length === 0) {
    throw new Error("connect a model provider before deploying a stage specialist");
  }
  // A switch reorders the chain so the chosen offering leads -- the same
  // `sourceOfferingIds`/`defaultSourceOfferingId` story every other deploy
  // uses, just with the person's pick standing in for "offerings[0]".
  const offerings = switchToOfferingId
    ? (() => {
        const chosen = catalogOfferings.find((offering) => offering.id === switchToOfferingId);
        if (!chosen) throw new Error("the chosen model is no longer a connected offering");
        return [chosen, ...catalogOfferings.filter((offering) => offering.id !== switchToOfferingId)];
      })()
    : catalogOfferings;
  const source = await sourceFor(transport, workspaceTenantId, offerings[0]!);
  if (!source) {
    throw new Error("the tenant's offering does not resolve to a known model");
  }

  // Only stage 5's specialist reads a project's audiences; every other
  // stage's prompt is stage-fixed and needs no project read at all.
  const project = stage === PACKAGE_STAGE ? await readProject(transport, projectId) : null;
  const audiences = project?.policy.audiences;

  const rendered = await renderSpecialistSource(closure, projectId, stage, source, artifactTools, roleKey, role, audiences);
  const commitSha = await pushWorkflowSourceTree(
    transport,
    workspaceTenantId,
    assetId,
    assetName,
    { ...rendered },
    switchToOfferingId ? `Switch stage ${stage} specialist model` : `Deploy stage ${stage} specialist`,
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
  // deployment for the same asset. Skipped for a switch: a live deployment
  // existing here is expected (the one being switched away from), not a race
  // to fold into.
  if (!switchToOfferingId) {
    const justDeployed = await resolveLiveDeployment(transport, projectId, stage, matching(await workflows.deployments()));
    if (justDeployed && (await deploymentIsLive(transport, workspaceTenantId, justDeployed.id))) {
      return { deploymentId: justDeployed.id, address: `${justDeployed.id}@${tenant.domain}` };
    }
  }

  // CL-8783 verdict: specialists deploy via the allocation path, NOT
  // `resolveModelSources` (which only the instance-launch route reaches, via
  // `run-source-resolution.ts`). The definition carries no `modelRequirements`
  // manifest (`ensureWorkflowDefinitionForAsset` projects the row over the
  // asset with no model manifest, so this deploys as a workflow rather than
  // launching as an instance); `DeployWorkflow` (`routes/workflows.ts`) has no
  // `modelRequirements` field, so `sourceOfferingIds` is the whole inference
  // story. Declaring per-specialist model needs is deferred to the full slice.
  const offeringIds = offerings.map((offering) => offering.id);
  const deployment = await workflows.deploy({
    source: { kind: "asset", assetId, package: { format: "source", commitSha, packageName: assetName } },
    entry: `./${SPECIALIST_ENTRY_PATH}`,
    sourceOfferingIds: offeringIds,
    defaultSourceOfferingId: offeringIds[0]!,
  });

  // A concurrent caller may have deployed onto this asset in the meantime;
  // re-resolve so every caller lands on the same, deterministically-chosen
  // deployment rather than each keeping the one it happened to create. Not
  // for a switch: `resolveLiveDeployment`'s oldest-wins fallback would pick
  // the deployment being switched AWAY from (it's older and still live) --
  // the switch record that would override that isn't written until the
  // caller (`switchSpecialistDeployment`) gets this result back, so the
  // deployment this call itself just created is unambiguously the answer.
  const winner = switchToOfferingId
    ? deployment
    : ((await resolveLiveDeployment(transport, projectId, stage, matching(await workflows.deployments()))) ?? deployment);

  // CL-8719: the credential the winning deployment's `credentialBindings`
  // names must exist -- and be scoped to the winning anchor run -- before
  // its first mail trigger launches it. Only reached on an actual (re)deploy,
  // never the early "already live" returns above: rotating the secret here
  // would break an in-flight tool call against a still-live prior deployment.
  // Skipped entirely when `artifactTools` is off -- the rendered source
  // carries no `credentialBindings` to satisfy, so minting one is dead work.
  // CL-8783: untouched by the model-needs verdict -- the hub's credential-push
  // (`pushSourceUpdatesToTenants`) already excludes deployment-anchor runs
  // (`anchorRunId IS NULL`), so this per-deployment bearer stays the only
  // credential story for specialists. See `docs/specialist-model-requirements.md`.
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
  /** Which of the stage's roles to deploy -- default is the primary
   *  per-stage agent, whose asset name this keeps byte-identical to before
   *  roles existed (`DEFAULT_ROLE_KEY`, `specialistAssetName`). */
  roleKey: string = DEFAULT_ROLE_KEY,
  /** Which agent the deployment actually runs. Defaults to the stage's own
   *  primary role, so every existing caller is unchanged; a caller naming a
   *  non-default `roleKey` must pass the matching role or the deployment
   *  would carry that name while running the stage specialist's prompt. */
  role: AgentRole = agentFor(stage),
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
      roleKey,
      role,
      undefined,
    );
  try {
    return await attempt();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return await attempt();
    throw cause;
  }
}

/** In-flight/queued `switchSpecialistDeployment` calls, keyed
 *  `${projectId}:${stage}:${roleKey}` -- see that function's doc comment. */
const switchQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `work` after every earlier call queued under the same `key` has
 * settled, so two rapid switches for the same project+stage+role never race
 * each other's read-decide-push-deploy-record sequence. The queue is a
 * plain chain (not a lock with a release): a call joins the tail, runs once
 * every prior entry has settled (success or failure), and its own
 * completion becomes the new tail. Because each call re-reads the durable
 * switch record (`readStageSwitch`) only once it actually starts, the LAST
 * call queued is the last to decide anything and the one whose choice ends
 * up recorded -- "the latest selection wins" falls out of queue order
 * rather than needing its own comparison.
 */
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = switchQueues.get(key) ?? Promise.resolve();
  const settled = prior.then(work, work);
  switchQueues.set(
    key,
    settled.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settled;
}

/**
 * CL-8899 "Switch model": deploys a NEW specialist for `projectId`'s
 * stage-`stage` asset whose inference chain leads with `offeringId`, even
 * though a live deployment already exists on that asset -- a stage
 * specialist's chain is frozen at deploy (`sourceOfferingIds`), so moving it
 * onto a different offering is a new deployment, never a live rebind.
 *
 * The hub cannot stop the old deployment's run (INTR-454), so it stays live;
 * what makes every subsequent reader of this asset (`stageSpecialistStatus`,
 * `ensureSpecialistDeployment`'s own existing-check, `useStageAgent`'s poll)
 * converge on the new one is the durable switch record this writes on
 * success (`writeStageSwitch`, on the project tenant's own config --
 * `resolveLiveDeployment` is what every reader consults), not a change to
 * the default oldest-wins pick itself.
 *
 * Two callers for the same project+stage+role are serialized (`serialize`
 * above) so a rapid double-switch (a slow click landing twice, two tabs)
 * never races the read-decide-deploy-record sequence; whichever call was
 * queued last is the one that runs last and whose record sticks. A repeat
 * switch to the offering already recorded as live is a no-op -- it neither
 * redeploys nor rewrites the record's timestamp.
 */
export async function switchSpecialistDeployment(
  transport: Transport,
  sidecar: SidecarCapability,
  closure: ClosureSource,
  gitPush: WorkflowGitPush,
  workspaceTenantId: string,
  projectId: string,
  stage: Stage,
  hubOrigin: string,
  offeringId: string,
  artifactTools = false,
  roleKey: string = DEFAULT_ROLE_KEY,
  role: AgentRole = agentFor(stage),
): Promise<SpecialistDeployment> {
  return serialize(`${projectId}:${stage}:${roleKey}`, async () => {
    const recorded = await readStageSwitch(transport, projectId, stage);
    if (recorded && recorded.offeringId === offeringId) {
      const status = await stageSpecialistStatus(transport, workspaceTenantId, projectId, stage, roleKey);
      // `resolveLiveDeployment` (inside `stageSpecialistStatus`) only
      // returns the recorded target while it's still live, so this check
      // both confirms the offering matches AND that there is nothing to do.
      if (status && status.deploymentId === recorded.deploymentId) {
        return { deploymentId: status.deploymentId, address: status.address };
      }
    }

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
        roleKey,
        role,
        offeringId,
      );
    let result: SpecialistDeployment;
    try {
      result = await attempt();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) result = await attempt();
      else throw cause;
    }
    await writeStageSwitch(transport, projectId, stage, {
      deploymentId: result.deploymentId,
      offeringId,
      switchedAt: new Date().toISOString(),
    });
    return result;
  });
}
