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
  gitTokensFor,
  readWorkflowSourceBlob,
  workflowsFor,
  type HubAsset,
  type HubDeployment,
} from "./hub.js";
import type { ClosureManifest } from "./closure-manifest.js";
import { visibleCatalog, type VisibleCatalog } from "./visible-catalog.js";
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

/** Whether the hub has ended this deployment for good: it will never be placed, fired or signalled again. */
export function deploymentHasEnded(deployment: Pick<HubDeployment, "status">): boolean {
  return ENDED_DEPLOYMENT_STATUSES.has(deployment.status);
}

/**
 * Whether this deployment's sidecar is still placed, or on its way: released,
 * releasing and failed deployments cannot be fired or signalled again.
 */
export async function deploymentIsLive(transport: Transport, tenantId: string, deploymentId: string): Promise<boolean> {
  const workflows = workflowsFor(transport, tenantId);
  return isLive((await workflows.deployments()).find((entry: HubDeployment) => entry.id === deploymentId));
}

/** Placed, from a caller's point of view: `running` is what a deployment
 *  the hub restored after a restart reports once its anchor run is on. */
function isPlaced(deployment: HubDeployment): boolean {
  return deployment.status === "deployed" || deployment.status === "running";
}

/**
 * How long a wait on the hub's placement may last. Every bound has a
 * default sized for a host start, when several deployments may be placed
 * one after another and each can take a minute or more.
 */
export type PlacementWait = {
  /** How long the hub may go with no deployment in the tenant changing
   *  before the wait gives up: the hub has stopped placing anything. */
  readonly stallMs?: number;
  /** The most a wait lasts however busy the hub stays. */
  readonly ceilingMs?: number;
  readonly pollMs?: number;
};

const PLACEMENT_STALL_MS = 120_000;
const PLACEMENT_CEILING_MS = 15 * 60_000;
const PLACEMENT_POLL_MS = 2_000;

/** Every deployment's status, so a change to any of them reads as the hub having moved. */
function placementFingerprint(deployments: readonly HubDeployment[]): string {
  return deployments
    .map((entry) => `${entry.id}:${entry.status}`)
    .sort()
    .join("\n");
}

/**
 * Polls the tenant's deployments until `read` settles on a result, and
 * gives up (null) only once the hub has visibly stopped: no deployment in
 * the tenant has appeared or changed status for `stallMs`, or the wait has
 * lasted `ceilingMs`. The hub places deployments one at a time, so a
 * deadline counted from the caller's own start ran out while the hub was
 * still working through the ones ahead of this caller's. Counting from the
 * hub's last visible move instead keeps a page waiting -- honestly, since
 * the hub is still placing -- rather than reporting a failure that a retry
 * a minute later would not see.
 */
export async function pollWhilePlacing<T>(
  workflows: { deployments: () => Promise<readonly HubDeployment[]> },
  read: (deployments: readonly HubDeployment[]) => Promise<T | null> | T | null,
  wait: PlacementWait = {},
): Promise<T | null> {
  const stallMs = wait.stallMs ?? PLACEMENT_STALL_MS;
  const ceilingMs = wait.ceilingMs ?? PLACEMENT_CEILING_MS;
  const pollMs = wait.pollMs ?? PLACEMENT_POLL_MS;
  const started = Date.now();
  let lastMove = started;
  let seen: string | undefined;
  for (;;) {
    const deployments = await workflows.deployments();
    const found = await read(deployments);
    if (found !== null) return found;
    const now = Date.now();
    const fingerprint = placementFingerprint(deployments);
    if (seen !== undefined && fingerprint !== seen) lastMove = now;
    seen = fingerprint;
    if (now - lastMove >= stallMs || now - started >= ceilingMs) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The events that end a run for good, whatever its deployment's status says. */
export const RUN_ENDED_EVENTS: ReadonlySet<string> = new Set(["RunCompleted", "RunFailed", "RunCancelled"]);

/** Whether `runId`'s own log holds a terminal event. A run with no log yet has not ended. */
export async function runHasEnded(transport: Transport, tenantId: string, deploymentId: string, runId: string): Promise<boolean> {
  try {
    const { events } = await workflowsFor(transport, tenantId).runEvents(deploymentId, runId);
    return events.some((event) => RUN_ENDED_EVENTS.has(event.type));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return false;
    throw cause;
  }
}

export type DeploymentUsability = "usable" | "ended" | "stalled";

/** How long a deployment the hub is still placing or restoring is waited for
 *  before it is given up on: the hub's own quiet, not a caller's clock. */
export const RECOVERY_WAIT: PlacementWait = { stallMs: 45_000 };

/**
 * Whether a deployment can take mail or a signal now (#236): placed, with a
 * run that has not ended. At boot the hub puts a dead deployment it means
 * to restore into `recovering`, which is live by status and unplaced, and a
 * run whose log already holds a terminal event cannot come back whatever
 * the restore does: mailing it answers 409 `workflow_run_terminal`. So a
 * deployment not yet placed is waited for within `wait`, the replacement
 * bounds rather than the fifteen-minute ceiling a placement wait allows,
 * and one that ends, whose run has ended, or that never places is not
 * handed back: the caller deploys afresh, as Try again would.
 */
export async function deploymentUsability(
  transport: Transport,
  tenantId: string,
  deploymentId: string,
  runId: string,
  wait: PlacementWait = RECOVERY_WAIT,
): Promise<DeploymentUsability> {
  const workflows = workflowsFor(transport, tenantId);
  const outcome = await pollWhilePlacing(
    workflows,
    (deployments) => {
      const found = deployments.find((entry: HubDeployment) => entry.id === deploymentId);
      if (!isLive(found)) return "ended" as const;
      if (isPlaced(found)) return "placed" as const;
      return null;
    },
    wait,
  );
  if (outcome === null) return "stalled";
  if (outcome === "ended") return "ended";
  return (await runHasEnded(transport, tenantId, deploymentId, runId)) ? "ended" : "usable";
}

/**
 * Resolves once the hub reports this deployment placed, so a caller does
 * not mail a run that has no placed sidecar yet. Returns false if it ends,
 * or if the hub stops placing (see `pollWhilePlacing`); the caller decides
 * how loudly to say so.
 */
export async function waitForDeploymentDeployed(
  transport: Transport,
  tenantId: string,
  deploymentId: string,
  wait: PlacementWait = {},
): Promise<boolean> {
  const workflows = workflowsFor(transport, tenantId);
  const outcome = await pollWhilePlacing(
    workflows,
    (deployments) => {
      const found = deployments.find((entry: HubDeployment) => entry.id === deploymentId);
      if (found && isPlaced(found)) return "placed" as const;
      if (!isLive(found)) return "ended" as const;
      return null;
    },
    wait,
  );
  return outcome === "placed";
}

/** The closure bytes a workflow deploy needs, fetched from the static
 *  tarballs `scripts/pack-closure-static.ts` writes under
 *  `apps/web/public/closure/` -- this package has no `node:fs` to read them
 *  itself. Supplied by the caller, the same way `SidecarCapability` is:
 *  apps/web fetches same-origin static files. */
export type ClosureSource = { manifest: ClosureManifest; fetchTarball: ClosureTarballFetcher };

/**
 * The (provider plugin, canonical model) pair the hub pins every rendered
 * agent step's source by, for the operator's first offering. The deploy
 * resolves each offering to a harness source keyed exactly this way, so the
 * agent's declared preference matches an approved source rather than falling
 * back to the default.
 */
export function pinFor(
  catalog: Pick<VisibleCatalog, "modelProviders" | "models">,
  offering: { providerId: string; modelId: string },
): InferenceSourcePin | undefined {
  // An offering points at a model provider (the catalog's `mpv_` row, whose
  // plugin names the inference adapter), not at the credential provider.
  const provider = catalog.modelProviders.find((row) => row.id === offering.providerId);
  const model = catalog.models.find((row) => row.id === offering.modelId);
  if (!provider || !model) return undefined;
  return { provider: provider.plugin, model: model.canonicalName };
}

/**
 * `pinFor` over the catalog `tenantId` can see: its own rows and, for a
 * project tenant, the workspace's it inherits (`visibleCatalog`). The
 * offering's referents can live on any tenant in that chain.
 */
export async function sourceFor(
  transport: Transport,
  tenantId: string,
  offering: { providerId: string; modelId: string },
): Promise<InferenceSourcePin | undefined> {
  return pinFor(await visibleCatalog(transport, tenantId), offering);
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
 * the caller, implemented over the browser's own `fetch`
 * (`apps/web/src/client.ts`) or, for a local smoke, the embedded host's
 * direct dispatch.
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
  // The listing is inherited (a child tenant lists its ancestors' assets
  // too), so the match is on the tenant as well as the name: a project
  // tenant must never adopt the workspace's same-named asset, whose repo
  // URL under the project's scope answers `404 no asset workflow/<name>`
  // to the push that follows (#29).
  const own = (asset: HubAsset) => asset.name === name && asset.tenantId === tenantId;
  const existing = (await assets.list("workflow")).find(own);
  if (existing) return existing.id;
  try {
    return (await assets.create({ kind: "workflow", name, displayName })).id;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) {
      const created = (await assets.list("workflow")).find(own);
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
