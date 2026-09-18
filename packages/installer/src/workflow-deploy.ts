/**
 * The project lifecycle as a hub deployment.
 *
 * The lifecycle is rendered to a workspace the hub's `workflow` asset kind
 * accepts: a lifecycle member whose entry builds the definition with
 * `@intx/workflow`, and the vendored `@intx` packages as sibling members so
 * the closure resolves to the vendored revision. It is pushed with a real
 * `git push` into the workflow asset's own repo -- a short-lived push token,
 * isomorphic-git in the browser, the token revoked once the push lands --
 * and deployed through the hub's own route at that commit (CL-8334; the same
 * stock-routes path `corbitsdev/workbench` PR #861 took for Myra). The hub
 * probes the source in a sidecar, freezes a `workflow_definition`, and
 * creates the anchor `workflow_run`. That row is what stage gates will park
 * on once the host's own in-process executor retires; until then both exist.
 */
import type { Transport } from "@intx/hub-client";
import {
  LIFECYCLE_ENTRY_PATH,
  lifecycleEntrySource,
  WORKFLOW_PACKAGE_DEPENDENCIES,
  type InferenceSourcePin,
} from "@solutions-builder/app/workflows/lifecycle-source";
import {
  assetsFor,
  catalogFor,
  gitTokensFor,
  readWorkflowSourceBlob,
  workflowsFor,
  type HubDeployment,
} from "./hub.js";
import { readProject } from "./project-tenant.js";
import { readDesignerSettings } from "./designer-settings.js";
import type { ClosureManifest } from "./registry-tarballs.js";
import {
  appMemberFiles,
  toolsDeckMemberFiles as toolsDeckClosureFiles,
  toolsDeliveryMemberFiles as toolsDeliveryClosureFiles,
  treeDigest,
  vendoredMemberFiles,
  type ClosureTarballFetcher,
} from "./workflow-closure.js";

/**
 * A deployment's status is its sidecar allocation's. These are the ones the
 * runtime still dispatches to (`isSidecarAllocationDispatchable` in
 * `@intx/types`); `releasing`, `released` and `failed` are not.
 */
const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

function isLive(deployment: HubDeployment | undefined): deployment is HubDeployment {
  return deployment !== undefined && !ENDED_DEPLOYMENT_STATUSES.has(deployment.status);
}

/**
 * Whether this deployment's sidecar is still placed, or on its way: released,
 * releasing and failed deployments cannot be fired or signalled again.
 */
export async function deploymentIsLive(transport: Transport, tenantId: string, deploymentId: string): Promise<boolean> {
  const workflows = workflowsFor(transport, tenantId);
  return isLive((await workflows.deployments()).find((entry: HubDeployment) => entry.id === deploymentId));
}

export const LIFECYCLE_ASSET_NAME = "solutions-builder-project-lifecycle";
const ENTRY_PATH = LIFECYCLE_ENTRY_PATH;
const ENTRY = `./${ENTRY_PATH}`;
const ACTIONS_PATH = "actions.js";
/** The workflow member inside the asset; the vendored @intx packages sit beside it. */
const LIFECYCLE_DIR = "packages/lifecycle";
const DIGEST_PATH = "closure.sha256";

/**
 * The `interchange.actions` module: the chat section's `route` step names
 * `routeMessage`, which parses the trigger envelope into the stage/command
 * the router gate chain reads (CL-8598; no loop body, no admit action --
 * rounds are chat-section steps now, not a loop the runtime iterates).
 */
function actionsModule(): string {
  return `export { routeMessage } from "@solutions-builder/app/admit";
`;
}

export type LifecycleSource = Readonly<Record<string, string>>;

/** One asset per project, in the workspace tenant, named so a listing reads. */
export function lifecycleAssetName(projectId?: string): string {
  return projectId ? `${LIFECYCLE_ASSET_NAME}-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : LIFECYCLE_ASSET_NAME;
}

/** The closure bytes `renderLifecycleSource` needs, fetched from the static
 *  tarballs `scripts/pack-closure-static.ts` writes under
 *  `apps/web/public/closure/` -- this package has no `node:fs` to read them
 *  itself. Supplied by the caller, the same way `SidecarCapability` and
 *  `RegistryTarballUploader` are: apps/web fetches same-origin static files,
 *  apps/hub never renders the lifecycle at all (`apps/hub/src/lifecycle-deploy.ts`). */
export type ClosureSource = { manifest: ClosureManifest; fetchTarball: ClosureTarballFetcher };

/**
 * The asset the sidecar evaluates: a workspace whose members are the lifecycle
 * package (a code entry that builds the definition with `@intx/workflow`, and
 * the actions module) and the vendored `@intx` packages it imports, so the
 * closure resolves to the vendored revision rather than npm. A digest of every
 * file sits at the root so a changed byte anywhere is a new deployment.
 */
export async function renderLifecycleSource(
  closure: ClosureSource,
  projectId?: string,
  source?: InferenceSourcePin,
  audiences?: readonly { name: string; role: string }[],
  audienceQuorum?: number,
  designerMaxTokens?: number,
): Promise<LifecycleSource> {
  const name = lifecycleAssetName(projectId);
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
    interchange: { workflow: ENTRY, actions: `./${ACTIONS_PATH}` },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    [`${LIFECYCLE_DIR}/package.json`]: `${JSON.stringify(member, null, 2)}\n`,
    [`${LIFECYCLE_DIR}/${ENTRY_PATH}`]: lifecycleEntrySource(
      source
        ? {
            source,
            ...(audiences ? { audiences } : {}),
            ...(audienceQuorum !== undefined ? { audienceQuorum } : {}),
            ...(designerMaxTokens !== undefined ? { designerMaxTokens } : {}),
          }
        : {},
    ),
    [`${LIFECYCLE_DIR}/${ACTIONS_PATH}`]: actionsModule(),
    // The build agent's tools ride beside the workflow runtime, as the
    // manifest's full `@intx/*` set (workflow's and tools-posix's closures
    // overlap on @intx/agent and @intx/types, which is fine).
    ...(await vendoredMemberFiles(closure.manifest, closure.fetchTarball)),
    // Stage 5's deck tool and stage 9's delivery-status tool, plus the
    // app's deck/delivery modules they call, so the sidecar resolves both
    // from the asset rather than a registry that does not carry them.
    ...(await appMemberFiles(closure.manifest, closure.fetchTarball)),
    ...(await toolsDeckClosureFiles(closure.manifest, closure.fetchTarball)),
    ...(await toolsDeliveryClosureFiles(closure.manifest, closure.fetchTarball)),
  };
  files[DIGEST_PATH] = `${await treeDigest(files)}\n`;
  return files;
}

/**
 * The (provider plugin, canonical model) pair the hub pins every rendered
 * agent step's source by, for the operator's first offering. The deploy
 * resolves each offering to a harness source keyed exactly this way, so the
 * agent's declared preference matches an approved source rather than falling
 * back to the default.
 */
async function sourceFor(
  transport: Transport,
  tenantId: string,
  offering: { providerId: string; modelId: string },
): Promise<InferenceSourcePin | undefined> {
  // An offering points at a model provider (the catalog's `mpv_` row, whose
  // plugin names the inference adapter), not at the credential provider.
  const catalog = catalogFor(transport, tenantId);
  const [providers, models] = await Promise.all([catalog.modelProviders(), catalog.models()]);
  const provider = providers.find((row) => row.id === offering.providerId);
  const model = models.find((row) => row.id === offering.modelId);
  if (!provider || !model) return undefined;
  return { provider: provider.plugin, model: model.canonicalName };
}

export type LifecycleDeployment =
  | { status: "no_offering" }
  | { status: "no_host" }
  | {
      status: "current" | "deployed";
      assetId: string;
      commitSha: string;
      deploymentId: string;
      deploymentStatus: string;
    };

async function lifecycleAsset(transport: Transport, tenantId: string, projectId?: string): Promise<string> {
  const assets = assetsFor(transport, tenantId);
  const name = lifecycleAssetName(projectId);
  const existing = (await assets.list("workflow")).find((asset) => asset.name === name);
  if (existing) return existing.id;
  return (await assets.create({ kind: "workflow", name, displayName: "Project lifecycle" })).id;
}

// The deployment projection carries no commit sha, so the sha is remembered
// per process after a write; a deployment found on a later launch reports
// its asset and status without one.
const commitsByAsset = new Map<string, string>();

/**
 * At most one lifecycle deploy per project at a time. Concurrent callers
 * would each write a commit and pin its sha, and the sidecar's pack --
 * indexed once at checkout -- cannot read back a sibling attempt's sha.
 * `replace: true` needs no special case: nothing is deduped away, so it
 * always runs a real redeploy.
 */
const queued = new Map<string | undefined, Promise<unknown>>();

/**
 * Whether this host is serving sidecars at all -- passed in rather than
 * reached for, since this package never imports the hub's embedding files.
 */
export type SidecarCapability = { canPlaceSidecars: boolean };

/**
 * Pushes `tree` onto `main` of the tenant's `<assetKind>/<assetName>` asset
 * repo over the hub's stock git smart-HTTP route and returns the new commit
 * sha. The push itself carries raw pkt-lines and a binary packfile, so it
 * cannot ride `Transport` (which always JSON-encodes) -- this is supplied by
 * the caller the same way `RegistryTarballUploader` is, implemented over the
 * browser's own `fetch` (`apps/web/src/client.ts`) or, for a local smoke,
 * the embedded host's direct dispatch.
 */
export type WorkflowGitPush = (args: {
  scope: string;
  assetKind: string;
  assetName: string;
  token: string;
  tree: Record<string, string>;
  message: string;
}) => Promise<string>;

export function ensureLifecycleDeployment(
  transport: Transport,
  sidecar: SidecarCapability,
  closure: ClosureSource,
  gitPush: WorkflowGitPush,
  tenantId: string,
  projectId?: string,
  options: { replace?: boolean } = {},
): Promise<LifecycleDeployment> {
  const deploy = () =>
    ensureLifecycleDeploymentUncached(transport, sidecar, closure, gitPush, tenantId, projectId, options);
  // Both arms are `deploy`, so this call starts once the one ahead has
  // settled, whether it succeeded or failed. The queue only orders; the
  // promise handed back is the real one, so a failure reaches its own caller
  // rather than the next caller in line.
  const mine = (queued.get(projectId) ?? Promise.resolve()).then(deploy, deploy);
  queued.set(projectId, mine);
  return mine;
}

/**
 * Makes sure the tenant holds a deployment of the lifecycle at the package's
 * current shape. Safe to call on every install: an unchanged tree with a
 * deployment behind it is a read, not a write. Callers go through
 * `ensureLifecycleDeployment` above, which serializes concurrent callers per
 * project; this is the racy sequence itself and must not be called directly.
 *
 * A project gets its own deployment: a deployment has one stable top-level
 * run, and that run is the project's lifecycle. The asset is named after
 * the project and lives in the workspace tenant, where the catalog offerings
 * are; a project tenant holds none of its own.
 */
/** A push token's lifetime: long enough for one push, short enough that a
 *  leaked token is worthless within minutes. */
const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

async function ensureLifecycleDeploymentUncached(
  transport: Transport,
  sidecar: SidecarCapability,
  closure: ClosureSource,
  gitPush: WorkflowGitPush,
  tenantId: string,
  projectId?: string,
  options: {
    /**
     * Deploy again even when a live deployment of the current shape exists.
     * For a deployment whose lifecycle run has ended: the deployment is
     * alive, its run is not, and a second run on the same anchor would reuse
     * the first run's iteration ids, so the project needs a new anchor.
     */
    replace?: boolean;
  } = {},
): Promise<LifecycleDeployment> {
  if (!sidecar.canPlaceSidecars) return { status: "no_host" };
  const catalog = catalogFor(transport, tenantId);
  const offerings = (await catalog.offerings())
    .filter((offering) => !offering.disabled)
    .sort((a, b) => a.priority - b.priority);
  if (offerings.length === 0) return { status: "no_offering" };

  // A project's own deployment renders against that project's audiences, so
  // an audience added or renamed changes the digest and redeploys — the same
  // upgrade path any other lifecycle change takes.
  const project = projectId ? await readProject(transport, projectId) : null;
  const audiences = project?.policy.audiences;
  // Stage 4's own output cap, from the workspace tenant's designer settings
  // asset — the same one the settings page reads and writes.
  const designerMaxTokens = (await readDesignerSettings(transport, tenantId)).maxTokens;
  const rendered = await renderLifecycleSource(
    closure,
    projectId,
    await sourceFor(transport, tenantId, offerings[0]!),
    audiences,
    project?.policy.audienceQuorum,
    designerMaxTokens,
  );
  const assetId = await lifecycleAsset(transport, tenantId, projectId);
  const head = await readWorkflowSourceBlob(transport, tenantId, assetId, DIGEST_PATH);
  const workflows = workflowsFor(transport, tenantId);
  // Only a deployment whose sidecar is still placed counts. Stopping the host
  // releases a project's sidecar, and a released deployment's anchor run is
  // terminal: it cannot be fired or signalled again. Handing that one back as
  // current left every project unable to draft after a restart, so the
  // lifecycle is deployed again instead, on the same source when unchanged.
  const latest = (await workflows.deployments()).find(
    (deployment: HubDeployment) => deployment.definitionAssetId === assetId && isLive(deployment),
  );
  if (head === rendered[DIGEST_PATH] && latest && !options.replace) {
    return {
      status: "current",
      assetId,
      commitSha: commitsByAsset.get(assetId) ?? "",
      deploymentId: latest.id,
      deploymentStatus: latest.status,
    };
  }

  const assetName = lifecycleAssetName(projectId);
  const gitTokens = gitTokensFor(transport, tenantId);
  const minted = await gitTokens.mint(assetId, `${assetName}-deploy`, PUSH_TOKEN_LIFETIME_MS);
  let commitSha: string;
  try {
    commitSha = await gitPush({
      scope: tenantId,
      assetKind: "workflow",
      assetName,
      token: minted.secret,
      tree: { ...rendered },
      message: "Project lifecycle generated from the transition ledger",
    });
  } finally {
    await gitTokens.revoke(minted.id);
  }
  commitsByAsset.set(assetId, commitSha);

  const ids = offerings.map((offering) => offering.id);
  const deployment = await workflows.deploy({
    source: {
      kind: "asset",
      assetId,
      package: { format: "source", commitSha, packageName: lifecycleAssetName(projectId) },
    },
    entry: ENTRY,
    sourceOfferingIds: ids,
    defaultSourceOfferingId: ids[0]!,
  });
  return {
    status: "deployed",
    assetId,
    commitSha,
    deploymentId: deployment.id,
    deploymentStatus: deployment.status,
  };
}
