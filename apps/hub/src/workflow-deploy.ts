/**
 * The project lifecycle as a hub deployment.
 *
 * The lifecycle is rendered to the two-file workflow package the hub's
 * `workflow` asset kind accepts — a manifest naming the entry, and an entry
 * module that default-exports the definition as inert JSON — committed to a
 * workflow asset, and deployed through the hub's own route. The hub probes the
 * source in a sidecar, freezes a `workflow_definition`, and creates the
 * anchor `workflow_run`. That row is what stage gates will park on once the
 * in-process executor (`hub-executor.ts`) retires; until then both exist.
 */
import { projectLifecycleDefinition } from "@solutions-builder/app/workflows/project-lifecycle";
import { continuingCommands, ROUND_STEP_ID } from "@solutions-builder/app/workflows/stage-loop";
import { assets, catalog, workflows, type HubDeployment } from "./hub-client.js";
import { readWorkflowSourceBlob, writeWorkflowSourceTree } from "./hub-gaps.js";
import { canPlaceSidecars } from "./hub-mount.js";

export const LIFECYCLE_ASSET_NAME = "solutions-builder-project-lifecycle";
const ENTRY_PATH = "workflow.js";
const ENTRY = `./${ENTRY_PATH}`;
const LOOPS_PATH = "loops.js";

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

/** The package the sidecar evaluates: a manifest and an inert-JSON entry. */
export function renderLifecycleSource(projectId?: string): LifecycleSource {
  const manifest = {
    name: lifecycleAssetName(projectId),
    version: "0.0.0",
    private: true,
    type: "module",
    interchange: { workflow: ENTRY, loops: `./${LOOPS_PATH}` },
  };
  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    [ENTRY_PATH]: `export default ${JSON.stringify(withoutStateSchemas(projectLifecycleDefinition()))};\n`,
    [LOOPS_PATH]: loopsModule(),
  };
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

  const source = renderLifecycleSource(projectId);
  const assetId = await lifecycleAsset(projectId);
  const head = await readWorkflowSourceBlob(assetId, ENTRY_PATH);
  const [latest] = (await workflows.deployments()).filter(
    (deployment: HubDeployment) => deployment.definitionAssetId === assetId,
  );
  if (head === source[ENTRY_PATH] && latest) {
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
    source: { kind: "asset", assetId, package: { format: "source", commitSha } },
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

/**
 * The sidecar's live-to-inert projector reifies `state.schema` through an
 * arktype `Type`, which inert JSON cannot carry; ours are arktype *definitions*
 * (plain objects) that the runtime never validates against. The deployed
 * package leaves state unschema'd; the ledger remains the statement of shape.
 */
function withoutStateSchemas<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => withoutStateSchemas(entry)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "state" && entry && typeof entry === "object" && "schema" in (entry as object)) continue;
      out[key] = withoutStateSchemas(entry);
    }
    return out as T;
  }
  return value;
}
