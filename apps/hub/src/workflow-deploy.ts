/**
 * The project lifecycle as a hub deployment.
 *
 * The lifecycle is rendered to a workspace the hub's `workflow` asset kind
 * accepts: a lifecycle member whose entry builds the definition with
 * `@intx/workflow`, and the vendored `@intx` packages as sibling members so
 * the closure resolves to the vendored revision. It is committed to a workflow
 * asset and deployed through the hub's own route. The hub probes the
 * source in a sidecar, freezes a `workflow_definition`, and creates the
 * anchor `workflow_run`. That row is what stage gates will park on once the
 * in-process executor (`hub-executor.ts`) retires; until then both exist.
 */
import {
  LIFECYCLE_ENTRY_PATH,
  lifecycleEntrySource,
  WORKFLOW_PACKAGE_DEPENDENCIES,
  type BuildSource,
} from "@solutions-builder/app/workflows/lifecycle-source";
import { continuingCommands, ROUND_STEP_ID } from "@solutions-builder/app/workflows/stage-loop";
import { assets, catalog, workflows, type HubDeployment } from "./hub-client.js";
import { readWorkflowSourceBlob, writeWorkflowSourceTree } from "./hub-gaps.js";
import { canPlaceSidecars } from "./hub-mount.js";
import { closureFiles, treeDigest, workspaceCatalog } from "./workflow-closure.js";

export const LIFECYCLE_ASSET_NAME = "solutions-builder-project-lifecycle";
const ENTRY_PATH = LIFECYCLE_ENTRY_PATH;
const ENTRY = `./${ENTRY_PATH}`;
const LOOPS_PATH = "loops.js";
/** The workflow member inside the asset; the vendored @intx packages sit beside it. */
const LIFECYCLE_DIR = "packages/lifecycle";
const DIGEST_PATH = "closure.sha256";

/**
 * The stage loop's `while` and `carry` refs, resolved by export name from the
 * package's own loops module. Pure data functions over the iteration's output,
 * which the runtime hands over as a record keyed by body step id: the one
 * `round` step's output is the signal payload, and the payload names the
 * ledger command a person issued. The loop goes on only while that command
 * keeps the stage in progress; a submit ends it and the run moves to the gate.
 * A terminal command (cancel, fail) ends it the same way and the run then
 * parks at the gate — the run is a shadow of the ledger, which is what
 * refuses or allows what happens next.
 */
function loopsModule(): string {
  const continues = JSON.stringify(continuingCommands());
  return `const CONTINUES = new Set(${continues});
function roundCommand(childOutput) {
  const round = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(ROUND_STEP_ID)}] : null;
  return round && typeof round === "object" && typeof round.command === "string" ? round.command : null;
}
export function stillOpen(childOutput) {
  const command = roundCommand(childOutput);
  return command !== null && CONTINUES.has(command);
}
export function carryRound(childOutput, carry) {
  const round = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(ROUND_STEP_ID)}] : null;
  return round ?? carry;
}
`;
}

export type LifecycleSource = Readonly<Record<string, string>>;

/** One asset per project, in the workspace tenant, named so a listing reads. */
export function lifecycleAssetName(projectId?: string): string {
  return projectId ? `${LIFECYCLE_ASSET_NAME}-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : LIFECYCLE_ASSET_NAME;
}

/**
 * The asset the sidecar evaluates: a workspace whose members are the lifecycle
 * package (a code entry that builds the definition with `@intx/workflow`, and
 * the loops module) and the vendored `@intx` packages it imports, so the
 * closure resolves to the vendored revision rather than npm. A digest of every
 * file sits at the root so a changed byte anywhere is a new deployment.
 */
export function renderLifecycleSource(projectId?: string, buildSource?: BuildSource): LifecycleSource {
  const name = lifecycleAssetName(projectId);
  const root = {
    name: `${name}-workspace`,
    version: "0.0.0",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
    catalog: workspaceCatalog(),
  };
  const member = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: WORKFLOW_PACKAGE_DEPENDENCIES,
    interchange: { workflow: ENTRY, loops: `./${LOOPS_PATH}` },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    [`${LIFECYCLE_DIR}/package.json`]: `${JSON.stringify(member, null, 2)}\n`,
    [`${LIFECYCLE_DIR}/${ENTRY_PATH}`]: lifecycleEntrySource(buildSource ? { buildSource } : {}),
    [`${LIFECYCLE_DIR}/${LOOPS_PATH}`]: loopsModule(),
    // The build agent's tools ride beside the workflow runtime; the two
    // closures overlap on @intx/agent and @intx/types, which is fine.
    ...closureFiles("workflow"),
    ...closureFiles("tools-posix"),
  };
  files[DIGEST_PATH] = `${treeDigest(files)}\n`;
  return files;
}

/**
 * The (provider plugin, canonical model) pair the hub pins a step's source by,
 * for the operator's first offering. The deploy resolves each offering to a
 * harness source keyed exactly this way, so the agent's declared preference
 * matches an approved source rather than falling back to the default.
 */
async function buildSourceFor(offering: { providerId: string; modelId: string }): Promise<BuildSource | undefined> {
  // An offering points at a model provider (the catalog's `mpv_` row, whose
  // plugin names the inference adapter), not at the credential provider.
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

async function lifecycleAsset(projectId?: string): Promise<string> {
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
 * Makes sure the tenant holds a deployment of the lifecycle at the package's
 * current shape. Safe to call on every install: an unchanged tree with a
 * deployment behind it is a read, not a write.
 *
 * A project gets its own deployment: a deployment has one stable top-level
 * run, and that run is the project's lifecycle. The asset is named after
 * the project and lives in the workspace tenant, where the catalog offerings
 * are; a project tenant holds none of its own.
 */
export async function ensureLifecycleDeployment(projectId?: string): Promise<LifecycleDeployment> {
  if (!canPlaceSidecars()) return { status: "no_host" };
  const offerings = (await catalog.offerings())
    .filter((offering) => !offering.disabled)
    .sort((a, b) => a.priority - b.priority);
  if (offerings.length === 0) return { status: "no_offering" };

  const source = renderLifecycleSource(projectId, await buildSourceFor(offerings[0]!));
  const assetId = await lifecycleAsset(projectId);
  const head = await readWorkflowSourceBlob(assetId, DIGEST_PATH);
  const [latest] = (await workflows.deployments()).filter(
    (deployment: HubDeployment) => deployment.definitionAssetId === assetId,
  );
  if (head === source[DIGEST_PATH] && latest) {
    return {
      status: "current",
      assetId,
      commitSha: commitsByAsset.get(assetId) ?? "",
      deploymentId: latest.id,
      deploymentStatus: latest.status,
    };
  }

  const { commitSha } = await writeWorkflowSourceTree({
    assetId,
    files: { ...source },
    message: "Project lifecycle generated from the transition ledger",
  });
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
