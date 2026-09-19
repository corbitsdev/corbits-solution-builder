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
import { assetsFor, catalogFor, gitTokensFor, workflowsFor, type HubDeployment } from "./hub.js";
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
 * Create-or-find a `workflow`-kind asset by name, so a workflow deploy (a
 * stage specialist's) has one to push its rendered source onto.
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
  return (await assets.create({ kind: "workflow", name, displayName })).id;
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
  const minted = await gitTokens.mint(assetId, `${assetName}-deploy`, PUSH_TOKEN_LIFETIME_MS);
  try {
    return await gitPush({ scope: tenantId, assetKind: "workflow", assetName, token: minted.secret, tree, message });
  } finally {
    await gitTokens.revoke(minted.id);
  }
}
