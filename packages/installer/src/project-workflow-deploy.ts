/**
 * The project workflow (CL-8721) as a hub deployment: one native `loop`
 * workflow per project, holding real review references and deciding a
 * project's stage-by-stage progress. Deployed lazily, once per project, and
 * reused after that -- the same ensure-and-reuse discipline
 * `specialist-deploy.ts`'s `ensureSpecialistDeployment` uses for a stage
 * specialist.
 */
import { ApiError, type Transport } from "@intx/hub-client";
import { assetsFor, catalogFor, getTenant, workflowsFor, type HubDeployment } from "./hub.js";
import {
  deploymentHasEnded,
  deploymentIsLive,
  ensureWorkflowAsset,
  pushWorkflowSourceTree,
  waitForDeploymentDeployed,
  waitForPushVisible,
  type SidecarCapability,
  type WorkflowGitPush,
} from "./workflow-deploy.js";

function normalizedProjectId(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** `sb-project-<projectId>-workflow`, normalized the same way
 *  `specialistAssetName` is. */
export function projectWorkflowAssetName(projectId: string): string {
  return `sb-project-${normalizedProjectId(projectId)}-workflow`;
}

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

/** See `specialist-deploy.ts`'s `pickDeployment`: a live deployment over an
 *  ended one, then the oldest `createdAt`, so every concurrent caller lands
 *  on the same winner. */
function pickDeployment(deployments: readonly HubDeployment[]): HubDeployment | undefined {
  return [...deployments].sort((a, b) => {
    const aLive = !ENDED_DEPLOYMENT_STATUSES.has(a.status);
    const bLive = !ENDED_DEPLOYMENT_STATUSES.has(b.status);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  })[0];
}

/** A loop-iteration child run id looks like `<runId>__<stepId>__<n>`; only a
 *  bare id (no `__`) is a top-level run this deployment was triggered as. */
function topLevelRunIds(runIds: readonly string[]): string[] {
  return runIds.filter((id) => !id.includes("__"));
}

/**
 * The one top-level run every caller of `ensureProjectWorkflow` converges
 * on when several already exist for this deployment (two browsers racing
 * the first-ever trigger). Run ids are opaque, unordered-by-time tokens
 * (`generateId`) -- `listWorkflowRuns` carries no `createdAt` -- so "oldest"
 * is approximated by a stable, total order over the ids themselves: every
 * caller sees the same set and sorts it the same way, so every caller lands
 * on the same run regardless of which order the hub happened to list them
 * in on that particular call.
 */
function pickTopLevelRun(runIds: readonly string[]): string | undefined {
  return [...runIds].sort()[0];
}

/** A decision as a run applied it: the signal to deliver again, verbatim, to a run that has to catch up. */
type ReceivedDecision = { readonly signalName: string; readonly signalId: string; readonly payload: unknown };

/** The loop iterations of `runId` among `runIds`, by index: the order the loop applied decisions in. */
function iterationRunIds(runId: string, runIds: readonly string[]): string[] {
  return runIds
    .filter((id) => id.startsWith(`${runId}__`))
    .map((id) => ({ id, index: Number(id.slice(id.lastIndexOf("__") + 2)) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * Every decision the loop applied to `runId`, in the order it applied them:
 * the signals its iterations received, iterations by index, events by seq,
 * each signal once. A signal that reached the top-level run but no
 * iteration was queued and never applied, so it is not part of the run's
 * state and not part of its history.
 */
async function appliedDecisions(
  workflows: ReturnType<typeof workflowsFor>,
  deploymentId: string,
  runId: string,
): Promise<ReceivedDecision[]> {
  const received: ReceivedDecision[] = [];
  const seen = new Set<string>();
  for (const id of iterationRunIds(runId, await workflows.runs(deploymentId))) {
    const { events } = await workflows.runEvents(deploymentId, id);
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (event.type !== "SignalReceived") continue;
      const { signalName, signalId, payload } = event.body;
      if (typeof signalName !== "string" || typeof signalId !== "string" || seen.has(signalId)) continue;
      seen.add(signalId);
      received.push({ signalName, signalId, payload });
    }
  }
  return received;
}

const TERMINAL_RUN_EVENTS = new Set(["RunCompleted", "RunFailed", "RunCancelled"]);

type ProjectRunCandidate = { readonly deployment: HubDeployment; readonly runId: string };

/** Every deployment that has a top-level run, oldest first, with the run every caller picks for it. */
async function candidatesWithRuns(
  workflows: ReturnType<typeof workflowsFor>,
  deployments: readonly HubDeployment[],
): Promise<ProjectRunCandidate[]> {
  const byAge = [...deployments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const candidates: ProjectRunCandidate[] = [];
  for (const deployment of byAge) {
    const runId = pickTopLevelRun(topLevelRunIds(await workflows.runs(deployment.id)));
    if (runId) candidates.push({ deployment, runId });
  }
  return candidates;
}

type ProjectRunState = {
  /** The run every reader converges on right now, or null when nothing holds the project's state. */
  readonly run: ProjectWorkflowDeployment | null;
  /** Whether `run` is on a deployment the hub can still place: false means it needs reviving. */
  readonly live: boolean;
  /** The live deployments with a run, oldest first. */
  readonly liveCandidates: readonly ProjectRunCandidate[];
  /** Every decision the dead deployments' runs took, in order, each once: what a live run must hold to be the project's. */
  readonly history: readonly ReceivedDecision[];
};

/**
 * Where a project's run is, across every deployment ever made for it.
 *
 * A host that gets killed outright, or stopped at all, leaves the hub
 * reporting the project's deployment ended -- failed, released -- and an
 * ended deployment is one the hub never places, fires or signals again.
 * The run parked there still holds the project's state, so it is still the
 * project's run until a live run has caught up with it: a live deployment
 * wins once it has received every decision the dead ones took. Reading a
 * live run that has not caught up is how a restart used to reset a project
 * to stage 1. A dead deployment whose run never took a decision holds
 * nothing and is passed over.
 */
async function projectRunState(
  workflows: ReturnType<typeof workflowsFor>,
  deployments: readonly HubDeployment[],
): Promise<ProjectRunState> {
  const candidates = await candidatesWithRuns(workflows, deployments);
  const liveCandidates = candidates.filter((candidate) => !deploymentHasEnded(candidate.deployment));
  const history: ReceivedDecision[] = [];
  const known = new Set<string>();
  let oldestDead: ProjectRunCandidate | null = null;
  for (const candidate of candidates.filter((entry) => deploymentHasEnded(entry.deployment))) {
    const decisions = await appliedDecisions(workflows, candidate.deployment.id, candidate.runId);
    if (decisions.length === 0) continue;
    oldestDead ??= candidate;
    for (const decision of decisions) {
      if (known.has(decision.signalId)) continue;
      known.add(decision.signalId);
      history.push(decision);
    }
  }
  const asRef = (candidate: ProjectRunCandidate): ProjectWorkflowDeployment => ({ deploymentId: candidate.deployment.id, runId: candidate.runId });
  for (const candidate of liveCandidates) {
    if (history.length === 0) return { run: asRef(candidate), live: true, liveCandidates, history };
    const held = new Set((await appliedDecisions(workflows, candidate.deployment.id, candidate.runId)).map((decision) => decision.signalId));
    if (history.every((decision) => held.has(decision.signalId))) return { run: asRef(candidate), live: true, liveCandidates, history };
  }
  if (oldestDead) return { run: asRef(oldestDead), live: false, liveCandidates, history };
  return { run: null, live: false, liveCandidates, history };
}

async function pollUntil<T>(timeoutMs: number, intervalMs: number, read: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Brings `target` up to `history`, one decision at a time: the loop takes
 * one signal per iteration, and signals delivered faster than that race
 * its log's single writer and fail the run. Each decision the run has not
 * applied is delivered again as the same signal under the same id, and the
 * next is not sent until an iteration has applied it. The hub treats a
 * byte-identical signal under an id it already holds as a no-op, and one it
 * refuses as a conflict is checked against what the run applied before it
 * counts as a failure, so a replay interrupted halfway resumes cleanly.
 */
async function catchUp(
  transport: Transport,
  workspaceTenantId: string,
  target: ProjectWorkflowDeployment,
  history: readonly ReceivedDecision[],
): Promise<void> {
  if (history.length === 0) return;
  const workflows = workflowsFor(transport, workspaceTenantId);
  if (!(await waitForDeploymentDeployed(transport, workspaceTenantId, target.deploymentId))) {
    throw new Error("the project's workflow did not reach deployed, so its history could not be replayed");
  }
  const topLevel = async () => (await workflows.runEvents(target.deploymentId, target.runId)).events;
  const started = await pollUntil(120_000, 1_500, async () => ((await topLevel()).some((event) => event.type === "RunStarted") ? true : null));
  if (!started) throw new Error("the project's workflow run never started, so its history could not be replayed");
  const applied = async () => new Set((await appliedDecisions(workflows, target.deploymentId, target.runId)).map((decision) => decision.signalId));
  let held = await applied();
  for (const decision of history) {
    if (held.has(decision.signalId)) continue;
    try {
      await workflows.signal(target.deploymentId, {
        runId: target.runId,
        signalName: decision.signalName,
        signalId: decision.signalId,
        payload: decision.payload,
      });
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    }
    const landed = await pollUntil(90_000, 1_500, async () => {
      held = await applied();
      if (held.has(decision.signalId)) return true;
      if ((await topLevel()).some((event) => TERMINAL_RUN_EVENTS.has(event.type))) throw new Error("the project's workflow ended while its history was being replayed");
      return null;
    });
    if (!landed) throw new Error(`the project's workflow did not apply decision ${decision.signalId} while catching up`);
  }
}

/** The bytes a project workflow deploy needs: the compiled
 *  `workflow.js`/`actions.js`/`loops.js` `scripts/project-workflow-pack.ts`
 *  produces, fetched by the caller the same way `ClosureSource` fetches
 *  closure tarballs -- this package has no bundler and no `node:fs`. */
export type ProjectWorkflowSource = { readonly files: Readonly<Record<string, string>> };

export type ProjectWorkflowStageInput = {
  readonly stage: number;
  readonly authorizedPrincipalIds: readonly string[];
};

export type ProjectWorkflowDeployment = { readonly deploymentId: string; readonly runId: string };

/** The asset a project workflow deploys into: a root workspace `package.json`,
 *  a member whose `interchange.workflow`/`actions`/`loops` point at the
 *  compiled entries, and the vendored `@intx/workflow` closure beside it. */
function renderProjectWorkflowSource(assetName: string, source: ProjectWorkflowSource): Record<string, string> {
  const root = { name: `${assetName}-workspace`, version: "0.0.0", private: true, type: "module", workspaces: ["packages/*"] };
  const member = {
    name: assetName,
    version: "0.0.0",
    private: true,
    type: "module",
    // `hono` satisfies `@logtape/hono`'s peer dependency inside the vendored
    // `@intx/workflow` closure (mirrors `deployed/package.json`'s own
    // declaration this replaces).
    dependencies: { "@intx/workflow": "workspace:*", hono: "^4.0.0" },
    interchange: { workflow: "./workflow.js", actions: "./actions.js", loops: "./loops.js" },
  };
  return {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    "packages/project/package.json": `${JSON.stringify(member, null, 2)}\n`,
    "packages/project/workflow.js": source.files["workflow.js"]!,
    "packages/project/actions.js": source.files["actions.js"]!,
    "packages/project/loops.js": source.files["loops.js"]!,
  };
}

function treeDigestPath(files: Record<string, string>): { path: string; content: string } {
  const path = "packages/project/actions.js";
  return { path, content: files[path]! };
}

async function ensureProjectWorkflowOnce(
  transport: Transport,
  sidecar: SidecarCapability,
  source: ProjectWorkflowSource,
  gitPush: WorkflowGitPush,
  workspaceTenantId: string,
  projectId: string,
  stages: readonly ProjectWorkflowStageInput[],
  vendoredWorkflowMemberFiles: Record<string, string>,
): Promise<ProjectWorkflowDeployment> {
  if (!sidecar.canPlaceSidecars) {
    throw new Error("no host is placing sidecars; cannot deploy a project workflow");
  }
  const tenant = await getTenant(transport, workspaceTenantId);
  if (!tenant) throw new Error("the workspace tenant does not exist");

  const assetName = projectWorkflowAssetName(projectId);
  const assetId = await ensureWorkflowAsset(transport, workspaceTenantId, assetName, `${projectId} project workflow`);

  const workflows = workflowsFor(transport, workspaceTenantId);
  const matching = (deployments: readonly HubDeployment[]) =>
    deployments.filter((deployment) => deployment.definitionAssetId === assetId);

  const existingDeployments = matching(await workflows.deployments());
  const state = await projectRunState(workflows, existingDeployments);
  if (state.run && state.live) return state.run;
  // A live run that has not caught up, or none: the project's history (if
  // any) is replayed onto the oldest live run, or onto a fresh one.
  if (state.liveCandidates[0]) {
    const target = { deploymentId: state.liveCandidates[0].deployment.id, runId: state.liveCandidates[0].runId };
    await catchUp(transport, workspaceTenantId, target, state.history);
    return target;
  }
  let deployment = pickDeployment(existingDeployments.filter((entry) => !deploymentHasEnded(entry)));
  if (!deployment || !(await deploymentIsLive(transport, workspaceTenantId, deployment.id))) {
    const rendered = { ...renderProjectWorkflowSource(assetName, source), ...vendoredWorkflowMemberFiles };
    const digestFile = treeDigestPath(rendered);
    const commitSha = await pushWorkflowSourceTree(
      transport,
      workspaceTenantId,
      assetId,
      assetName,
      rendered,
      "Deploy project workflow",
      gitPush,
    );
    await waitForPushVisible(transport, workspaceTenantId, assetId, digestFile.path, digestFile.content);

    // A concurrent caller may have deployed onto this asset while the push
    // above was in flight; re-check before deploying a second live one.
    const justDeployed = pickDeployment(matching(await workflows.deployments()));
    if (justDeployed && (await deploymentIsLive(transport, workspaceTenantId, justDeployed.id))) {
      deployment = justDeployed;
    } else {
      // The project workflow runs no inference itself, but a deploy still
      // requires a non-empty offering chain -- the tenant's first offering is
      // pinned and simply never dispatched to.
      const offerings = (await catalogFor(transport, workspaceTenantId).offerings())
        .filter((offering) => !offering.disabled)
        .sort((a, b) => a.priority - b.priority);
      if (offerings.length === 0) {
        throw new Error("connect a model provider before deploying the project workflow");
      }
      const offeringIds = offerings.map((offering) => offering.id);
      const deployed = await workflows.deploy({
        source: { kind: "asset", assetId, package: { format: "source", commitSha, packageName: assetName } },
        entry: "./workflow.js",
        sourceOfferingIds: offeringIds,
        defaultSourceOfferingId: offeringIds[0]!,
      });
      deployment = pickDeployment(matching(await workflows.deployments())) ?? deployed;
    }
  }

  // Reuse the first-ever top-level run triggered against this deployment,
  // the same way `deployment` above resolves to the one winner across
  // concurrent callers: list, and if none exists yet, trigger once and
  // re-list so every caller settles on the same (earliest) run id.
  const existingRuns = topLevelRunIds(await workflows.runs(deployment.id));
  const existingRun = pickTopLevelRun(existingRuns);
  const target = existingRun
    ? { deploymentId: deployment.id, runId: existingRun }
    : await (async () => {
        const payload = { projectId, stages };
        const fired = await workflows.trigger(deployment.id, { content: JSON.stringify(payload) });
        const afterTrigger = topLevelRunIds(await workflows.runs(deployment.id));
        return { deploymentId: deployment.id, runId: pickTopLevelRun(afterTrigger) ?? fired.runId };
      })();
  await catchUp(transport, workspaceTenantId, target, state.history);
  return target;
}

/**
 * Makes sure `projectId` has a live project workflow deployment, with its ONE
 * top-level run triggered, and hands back both ids. Deploys/triggers lazily,
 * once per project; on later calls, reuses the live deployment and the
 * already-triggered run rather than deploying or triggering again. Retries
 * once on a 409, the same way `ensureSpecialistDeployment` absorbs a
 * concurrent caller's race on the asset-create or push-token-mint step.
 */
export async function ensureProjectWorkflow(
  transport: Transport,
  sidecar: SidecarCapability,
  source: ProjectWorkflowSource,
  gitPush: WorkflowGitPush,
  workspaceTenantId: string,
  projectId: string,
  stages: readonly ProjectWorkflowStageInput[],
  vendoredWorkflowMemberFiles: Record<string, string>,
): Promise<ProjectWorkflowDeployment> {
  const attempt = () =>
    ensureProjectWorkflowOnce(transport, sidecar, source, gitPush, workspaceTenantId, projectId, stages, vendoredWorkflowMemberFiles);
  try {
    return await attempt();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return await attempt();
    throw cause;
  }
}

/**
 * The same deployment/run `ensureProjectWorkflow` would reuse, without
 * deploying or triggering anything -- for a page that just needs to read the
 * project workflow's current stage (`project-view.ts`'s `loadProjectView`).
 * Null when the project has no workflow asset yet (a brand-new project the
 * workspace has not ensured yet), or no deployment on it has ever had a
 * top-level run triggered -- either of which means there is nothing here to
 * fold yet; the caller treats the project as still at stage 1 until
 * `StageWorkspace` ensures and triggers the workflow.
 */
export async function findProjectWorkflow(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
): Promise<ProjectWorkflowDeployment | null> {
  const assetName = projectWorkflowAssetName(projectId);
  const asset = (await assetsFor(transport, workspaceTenantId).list("workflow")).find((entry) => entry.name === assetName);
  if (!asset) return null;

  const workflows = workflowsFor(transport, workspaceTenantId);
  const deployments = (await workflows.deployments()).filter((entry) => entry.definitionAssetId === asset.id);
  return (await projectRunState(workflows, deployments)).run;
}
