/**
 * Shared deploy helpers a stage specialist's deployment
 * (`specialist-deploy.ts`) uses: creating or finding a `workflow`-kind asset,
 * pushing a rendered source tree onto it with a short-lived push token, and
 * resolving the tenant's chosen offering to an inference source pin. The
 * per-project lifecycle deployment these helpers used to also serve is gone
 * (contract v6: one specialist agent per stage per project, deployed lazily,
 * no chat section, no approve chain).
 */
import type { Transport } from "@intx/hub-client";
import type { InferenceSourcePin } from "@solutions-builder/app/specialist-source";
import {
  ApiError,
  assetsFor,
  catalogFor,
  gitTokensFor,
  readWorkflowSourceBlob,
  workflowsFor,
  type HubDeployment,
} from "./hub.js";
import type { ClosureManifest } from "./registry-tarballs.js";
import { type ClosureTarballFetcher } from "./workflow-closure.js";

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

/** The closure bytes a workflow deploy needs, fetched from the static
 *  tarballs `scripts/pack-closure-static.ts` writes under
 *  `apps/web/public/closure/` -- this package has no `node:fs` to read them
 *  itself. Supplied by the caller, the same way `SidecarCapability` and
 *  `RegistryTarballUploader` are: apps/web fetches same-origin static files. */
export type ClosureSource = { manifest: ClosureManifest; fetchTarball: ClosureTarballFetcher };

/**
 * The (provider plugin, canonical model) pair the hub pins every rendered
 * agent step's source by, for the operator's first offering. The deploy
 * resolves each offering to a harness source keyed exactly this way, so the
 * agent's declared preference matches an approved source rather than falling
 * back to the default.
 */
export async function sourceFor(
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

/** A push token's lifetime: long enough for one push, short enough that a
 *  leaked token is worthless within minutes. */
const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/**
 * A push token's name, suffixed with a short random tag so two overlapping
 * deploys for the same asset never mint the same name and collide on the
 * hub's per-user active-token uniqueness constraint.
 */
function pushTokenName(assetName: string): string {
  return `${assetName}-deploy-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Mints a push token, retrying once with a fresh random-suffixed name if the
 * hub rejects the mint because an overlapping deploy already holds an active
 * token by that name (a race between two `ensureSpecialistDeployment` calls
 * for the same project/stage).
 */
async function mintPushToken(
  gitTokens: ReturnType<typeof gitTokensFor>,
  assetId: string,
  assetName: string,
) {
  try {
    return await gitTokens.mint(assetId, pushTokenName(assetName), PUSH_TOKEN_LIFETIME_MS);
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 409 || cause.status === 500)) {
      return await gitTokens.mint(assetId, pushTokenName(assetName), PUSH_TOKEN_LIFETIME_MS);
    }
    throw cause;
  }
}

/**
 * Create-or-find a `workflow`-kind asset by name, so a workflow deploy (a
 * stage specialist's) has one to push its rendered source onto. Two browsers
 * opening the same project's stage within seconds both reach this
 * list-then-create with no existing row, so the loser's create races the
 * winner's and the hub answers 409 ("asset already exists"): that is
 * success too, not a failure to surface, so it re-lists and returns the row
 * the winner made.
 */
export async function ensureWorkflowAsset(
  transport: Transport,
  tenantId: string,
  name: string,
  displayName: string,
): Promise<string> {
  const assets = assetsFor(transport, tenantId);
  const existing = (await assets.list("workflow")).find((asset) => asset.name === name);
  if (existing) return existing.id;
  try {
    return (await assets.create({ kind: "workflow", name, displayName })).id;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) {
      const created = (await assets.list("workflow")).find((asset) => asset.name === name);
      if (created) return created.id;
    }
    throw cause;
  }
}

/**
 * Pushes a rendered source tree onto a workflow asset's `main`, minting and
 * revoking a short-lived push token around the push.
 */
export async function pushWorkflowSourceTree(
  transport: Transport,
  tenantId: string,
  assetId: string,
  assetName: string,
  tree: Record<string, string>,
  message: string,
  gitPush: WorkflowGitPush,
): Promise<string> {
  const gitTokens = gitTokensFor(transport, tenantId);
  const minted = await mintPushToken(gitTokens, assetId, assetName);
  try {
    return await gitPush({ scope: tenantId, assetKind: "workflow", assetName, token: minted.secret, tree, message });
  } finally {
    await gitTokens.revoke(minted.id);
  }
}

/** How long `waitForPushVisible` polls before giving up. */
const PUSH_VISIBILITY_TIMEOUT_MS = 5_000;
const PUSH_VISIBILITY_POLL_MS = 250;

/**
 * Blocks until `path` on the asset's default ref reads back as `expected`
 * (or the timeout elapses).
 *
 * The hub's own deploy path (`bindAssetAttachmentResolver` in
 * `workflow-closure-resolution.ts`) resolves the asset's default ref fresh
 * at closure-delivery time -- independently of the commit sha our push
 * returned -- to build the git pack it hands the sidecar. When that ref
 * read races the push's own ref update (most visible on a brand-new asset's
 * first deploy, where there is no prior commit to fall back to), it can pack
 * a state that pre-dates the commit we just pushed; the sidecar's pinned
 * subtree read then fails with `git.materialization.failed` and the
 * deployment is released. Polling the same asset-blob read route the hub's
 * resolver uses, for a file we just wrote, waits out that visibility window
 * instead of racing it.
 */
export async function waitForPushVisible(
  transport: Transport,
  tenantId: string,
  assetId: string,
  path: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + PUSH_VISIBILITY_TIMEOUT_MS;
  for (;;) {
    const content = await readWorkflowSourceBlob(transport, tenantId, assetId, path);
    if (content === expected) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, PUSH_VISIBILITY_POLL_MS));
  }
}
