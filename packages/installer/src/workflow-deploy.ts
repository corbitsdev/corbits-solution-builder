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
 * host's own in-process executor retires; until then both exist.
 */
import type { Transport } from "@intx/hub-client";
import {
  LIFECYCLE_ENTRY_PATH,
  lifecycleEntrySource,
  WORKFLOW_PACKAGE_DEPENDENCIES,
  type InferenceSourcePin,
} from "@solutions-builder/app/workflows/lifecycle-source";
import { continuingCommands, ADMIT_STEP_ID, EVIDENCE_STEP_ID, ROUND_STEP_ID } from "@solutions-builder/app/workflows/stage-loop";
import {
  assetsFor,
  catalogFor,
  readWorkflowSourceBlob,
  workflowsFor,
  writeWorkflowSourceTree,
  type HubDeployment,
} from "./hub.js";
import { readProject } from "./project-tenant.js";
import { readDesignerSettings } from "./designer-settings.js";
import {
  closureFiles,
  deckAppMemberFiles,
  toolsDeckMemberFiles,
  toolsDeliveryMemberFiles,
  treeDigest,
  workspaceCatalog,
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

/**
 * Whether this host can reach the deployment's sidecar. The platform pins an
 * allocation to the hub address the sidecar dials, and leaves one pinned to
 * any other address alone forever: a host that came back on a different
 * port sees such a deployment as live, while nothing sent to it is ever
 * delivered. (A deployment with no allocation yet is reachable: the
 * allocation it gets will be this host's.) The binding fingerprint travels
 * on the deployment listing itself now (`vendor/interchange/PATCHES.md`),
 * so no separate read is needed -- the caller's own fingerprint is the one
 * fact only the host process knows, so it is a plain argument, not a gap.
 */
function reachable(deployment: HubDeployment, sidecarFingerprint: string): boolean {
  const binding = deployment.provisionerBindingFingerprint ?? null;
  return binding === null || binding === sidecarFingerprint;
}

export const LIFECYCLE_ASSET_NAME = "solutions-builder-project-lifecycle";
const ENTRY_PATH = LIFECYCLE_ENTRY_PATH;
const ENTRY = `./${ENTRY_PATH}`;
const LOOPS_PATH = "loops.js";
const ACTIONS_PATH = "actions.js";
/** The workflow member inside the asset; the vendored @intx packages sit beside it. */
const LIFECYCLE_DIR = "packages/lifecycle";
const DIGEST_PATH = "closure.sha256";

/**
 * The stage loop's `while` and `carry` refs, resolved by export name from the
 * package's own loops module. Pure data functions over the iteration's output,
 * which the runtime hands over as a record keyed by body step id.
 *
 * The revise loop's `round` step output is the signal payload, and the payload
 * names the ledger command a person issued. At stage 8 the evidence park after
 * the build agent is the command that decides whether the loop goes on: fail
 * starts another round, accept ends it. Other stages still read `round`.
 * A submit ends the loop and the run moves to the gate.
 *
 * A gate loop's `admit` step output is the verdict: refused means wait again.
 */
function loopsModule(): string {
  const continues = JSON.stringify(continuingCommands());
  return `const CONTINUES = new Set(${continues});
function roundCommand(childOutput) {
  const evidence = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(EVIDENCE_STEP_ID)}] : null;
  if (evidence && typeof evidence === "object" && typeof evidence.command === "string") return evidence.command;
  const round = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(ROUND_STEP_ID)}] : null;
  return round && typeof round === "object" && typeof round.command === "string" ? round.command : null;
}
export function stillOpen(childOutput) {
  const command = roundCommand(childOutput);
  return command !== null && CONTINUES.has(command);
}
export function carryRound(childOutput, carry) {
  const evidence = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(EVIDENCE_STEP_ID)}] : null;
  if (evidence) return evidence;
  const round = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(ROUND_STEP_ID)}] : null;
  return round ?? carry;
}
function admitOutput(childOutput) {
  const admit = childOutput && typeof childOutput === "object" ? childOutput[${JSON.stringify(ADMIT_STEP_ID)}] : null;
  return admit && typeof admit === "object" ? admit : null;
}
export function gateRefused(childOutput) {
  const admit = admitOutput(childOutput);
  return admit !== null && admit.refused === true;
}
export function carryGate(childOutput, carry) {
  const admit = admitOutput(childOutput);
  return admit ?? carry;
}
`;
}

/**
 * The `interchange.actions` module: the gate loop names `admitGate`, and a
 * drafted stage's round names `admitDraftGate` right after its own signal —
 * the workflow's own check on a `stage.draft` round's intent, since the
 * client delivers that signal straight to the run.
 */
function actionsModule(): string {
  return `export { admitGate, admitDraftGate } from "@solutions-builder/app/admit";
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
export function renderLifecycleSource(
  projectId?: string,
  source?: InferenceSourcePin,
  audiences?: readonly { name: string; role: string }[],
  audienceQuorum?: number,
  designerMaxTokens?: number,
): LifecycleSource {
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
    interchange: { workflow: ENTRY, loops: `./${LOOPS_PATH}`, actions: `./${ACTIONS_PATH}` },
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
    [`${LIFECYCLE_DIR}/${LOOPS_PATH}`]: loopsModule(),
    [`${LIFECYCLE_DIR}/${ACTIONS_PATH}`]: actionsModule(),
    // The build agent's tools ride beside the workflow runtime; the two
    // closures overlap on @intx/agent and @intx/types, which is fine.
    ...closureFiles("workflow"),
    ...closureFiles("tools-posix"),
    // Stage 5's deck tool and stage 9's delivery-status tool, plus the
    // app's deck/delivery modules they call, so the sidecar resolves both
    // from the asset rather than a registry that does not carry them.
    ...deckAppMemberFiles(),
    ...toolsDeckMemberFiles(),
    ...toolsDeliveryMemberFiles(),
  };
  files[DIGEST_PATH] = `${treeDigest(files)}\n`;
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
 * The two facts about sidecar placement that only the host process knows --
 * whether it is serving at all, and its own binding fingerprint -- passed in
 * rather than reached for, since this package never imports the hub's
 * embedding files.
 */
export type SidecarCapability = { canPlaceSidecars: boolean; sidecarFingerprint: string };

export function ensureLifecycleDeployment(
  transport: Transport,
  sidecar: SidecarCapability,
  tenantId: string,
  projectId?: string,
  options: { replace?: boolean } = {},
): Promise<LifecycleDeployment> {
  const deploy = () => ensureLifecycleDeploymentUncached(transport, sidecar, tenantId, projectId, options);
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
async function ensureLifecycleDeploymentUncached(
  transport: Transport,
  sidecar: SidecarCapability,
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
  const rendered = renderLifecycleSource(
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
  if (latest && !reachable(latest, sidecar.sidecarFingerprint)) {
    console.error(
      `[deploy] ${projectId ?? "workspace"}: deployment ${latest.id} is bound to a hub address this host no longer serves; deploying the lifecycle again.`,
    );
  } else if (head === rendered[DIGEST_PATH] && latest && !options.replace) {
    return {
      status: "current",
      assetId,
      commitSha: commitsByAsset.get(assetId) ?? "",
      deploymentId: latest.id,
      deploymentStatus: latest.status,
    };
  }

  const { commitSha } = await writeWorkflowSourceTree(transport, tenantId, {
    assetId,
    files: { ...rendered },
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
