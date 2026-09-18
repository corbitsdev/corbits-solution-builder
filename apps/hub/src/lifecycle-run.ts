/**
 * Reads of the project's lifecycle deployment, as a thin hub client.
 *
 * Each project has its own deployment of the generated lifecycle, rendered
 * and fired by the client (`@solutions-builder/installer`'s
 * `ensureLifecycleDeployment`, `@intx/hub-client`'s `triggerWorkflowRun`).
 * The host never deploys or launches a run any more — this module only
 * resolves which deployment is the project's current anchor, for the read
 * paths (the stage thread, the project list/detail) that still ask "which
 * run is this project's".
 */
import { loopBodyRunId } from "@intx/workflow";
import type { Stage } from "@solutions-builder/app/ledger";
import { reviseStepId } from "@solutions-builder/app/workflows/stage-loop";
import { assets, catalog, deploymentRuns, workflows, type HubDeployment, type HubRunEvent } from "./hub-client.js";
import { canPlaceSidecars, hub } from "./hub-mount.js";

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

function isLive(deployment: HubDeployment | undefined): deployment is HubDeployment {
  return deployment !== undefined && !ENDED_DEPLOYMENT_STATUSES.has(deployment.status);
}

function reachable(deployment: HubDeployment, sidecarFingerprint: string): boolean {
  const binding = deployment.provisionerBindingFingerprint ?? null;
  return binding === null || binding === sidecarFingerprint;
}

export const LIFECYCLE_ASSET_NAME = "solutions-builder-project-lifecycle";

export function lifecycleAssetName(projectId?: string): string {
  return projectId ? `${LIFECYCLE_ASSET_NAME}-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : LIFECYCLE_ASSET_NAME;
}

/**
 * The deployment id the project's lifecycle is running under, resolved fresh
 * every call. Nothing here caches: the installer deploys and redeploys the
 * lifecycle (a stakeholder write bumps its policy and redeploys), and this
 * only ever reads whatever the installer most recently placed.
 */
async function anchorFor(projectId: string): Promise<string | null> {
  if (!canPlaceSidecars()) return null;
  const offerings = (await catalog.offerings()).filter((offering) => !offering.disabled);
  if (offerings.length === 0) return null;
  const name = lifecycleAssetName(projectId);
  const asset = (await assets.list("workflow")).find((entry) => entry.name === name);
  if (!asset) return null;
  const sidecarFingerprint = hub().sidecarBindingFingerprint;
  const latest = (await workflows.deployments()).find(
    (deployment) => deployment.definitionAssetId === asset.id && isLive(deployment) && reachable(deployment, sidecarFingerprint),
  );
  return latest?.id ?? null;
}

/** The deployment id the project's lifecycle is running under, once resolved. */
export async function currentAnchor(projectId: string): Promise<string | null> {
  return anchorFor(projectId);
}

/**
 * Every anchor the project's lifecycle has run under, oldest first: one per
 * deployment of its asset. Stopping the host releases the sidecar, so each
 * start deploys the lifecycle again under a new anchor and aligns it to
 * where the ledger stands; the rounds a stage recorded before that are
 * under the earlier anchors, and they are still the stage's conversation.
 * Read once per process, then extended as the current anchor changes: a
 * deployment that is not the current one gains no runs after this host
 * started.
 */
const anchorHistory = new Map<string, string[]>();

async function anchorsFor(projectId: string): Promise<string[]> {
  const current = await anchorFor(projectId);
  let history = anchorHistory.get(projectId);
  if (!history) {
    const name = lifecycleAssetName(projectId);
    const asset = (await assets.list("workflow")).find((entry) => entry.name === name);
    history = asset
      ? (await workflows.deployments())
          .filter((deployment) => deployment.definitionAssetId === asset.id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((deployment) => deployment.id)
      : [];
    anchorHistory.set(projectId, history);
  }
  if (current && !history.includes(current)) history.push(current);
  return history;
}

/** The run ids under an anchor that is no longer current. Those never change, so they are read once. */
const settledRunIds = new Map<string, string[]>();

async function runIdsUnder(anchor: string, current: boolean): Promise<string[]> {
  if (current) return deploymentRuns.list(anchor);
  const known = settledRunIds.get(anchor);
  if (known) return known;
  const listed = await deploymentRuns.list(anchor);
  settledRunIds.set(anchor, listed);
  return listed;
}

export type StageIteration = { readonly runId: string; readonly events: HubRunEvent[] };

/**
 * Every iteration child run of a stage's revise loop, oldest first.
 *
 * A loop iteration's run id is deterministic (`loopBodyRunId`), so rather
 * than folding every run's `state.children` map (as the client's own fold
 * does, to learn which stage a parked run belongs to) this walks the index
 * straight: iteration 0, 1, 2, ... until one is not among the deployment's
 * run ids. That is the one place this stage-thread projection needs to know
 * how a loop names its children; everything past this function reads
 * iterations as plain `{runId, events}` pairs.
 */
export async function stageIterations(
  projectId: string,
  stage: Stage,
  options: {
    /**
     * Only the anchor the project runs under now. A round can only run
     * there, so a caller waiting on one must not read an earlier anchor's
     * parked iteration as the newest; the thread, which reads history,
     * wants every anchor.
     */
    readonly currentOnly?: boolean;
  } = {},
): Promise<StageIteration[]> {
  const current = await anchorFor(projectId);
  const history = options.currentOnly ? (current ? [current] : []) : await anchorsFor(projectId);
  const loopId = reviseStepId(stage);
  const iterations: StageIteration[] = [];
  // Oldest anchor first, so the newest iteration is last whichever anchor
  // it ran under.
  for (const anchor of history) {
    const runIds = new Set(await runIdsUnder(anchor, anchor === current));
    for (let index = 0; ; index += 1) {
      const runId = loopBodyRunId(anchor, loopId, index);
      if (!runIds.has(runId)) break;
      iterations.push({ runId, events: await deploymentRuns.events(anchor, runId) });
    }
  }
  return iterations;
}

/**
 * Resolves a step output ref to the value it names: `inline:<json>` is
 * parsed directly (the ref carries the value itself), `blob:<sha>` is
 * fetched through the deployment's blob route first. One place to change if
 * the ref format ever grows a third shape.
 */
export async function readOutputRef(anchor: string, runId: string, ref: string): Promise<unknown> {
  if (ref.startsWith("inline:")) return JSON.parse(ref.slice("inline:".length));
  const match = /^blob:(.+)$/.exec(ref);
  if (!match) throw new Error(`Unrecognized step output ref: ${ref}`);
  const bytes = await deploymentRuns.blob(anchor, runId, match[1]!);
  if (!bytes) throw new Error(`Blob ${match[1]} for run ${runId} was not found.`);
  return JSON.parse(new TextDecoder().decode(bytes));
}
