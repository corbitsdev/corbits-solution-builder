/**
 * The project workflow (CL-8721) as a hub deployment: one native `loop`
 * workflow per project, holding real review references and deciding a
 * project's stage-by-stage progress. Deployed lazily, once per project, and
 * reused after that -- the same ensure-and-reuse discipline
 * `specialist-deploy.ts`'s `ensureSpecialistDeployment` uses for a stage
 * specialist.
 */
import { ApiError, type Transport } from "@intx/hub-client";
import { catalogFor, getTenant, workflowsFor, type HubDeployment } from "./hub.js";
import {
  deploymentIsLive,
  ensureWorkflowAsset,
  pushWorkflowSourceTree,
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

  let deployment = pickDeployment(matching(await workflows.deployments()));
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
  if (existingRun) return { deploymentId: deployment.id, runId: existingRun };

  const payload = { projectId, stages };
  const fired = await workflows.trigger(deployment.id, { content: JSON.stringify(payload) });
  const afterTrigger = topLevelRunIds(await workflows.runs(deployment.id));
  return { deploymentId: deployment.id, runId: pickTopLevelRun(afterTrigger) ?? fired.runId };
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
