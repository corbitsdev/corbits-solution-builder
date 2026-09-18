/**
 * `loadProjectView`: the project detail read, folded in the browser from the
 * project's own tenant record, its run fold, and its artifact fold — what
 * `GET /projects/:id` and `GET /projects/:id/graph` used to answer (CL-8510,
 * step C of CL-8072; design fixed by CL-8500 steps A/#363 and B/#370).
 *
 * `current`/`runs`/`soloApproval` coarsen the host's own ledger-run model
 * (`apps/hub/src/runs.ts`), which folds host-committed ledger-command
 * mutations no client fold reconstructs — that table is `command-ledger.ts`'s
 * to keep or drop in a later step (CL-8492), not this one's. `current.state`
 * here distinguishes only what the stage workspace actually branches on —
 * drafting / waiting on a gate / stage 7's cost-approved hand-off to the
 * freeze — from the run fold's own parked/running signal. Build-attempt
 * sub-states (`queued`/`running`/`failed`/`cancelled`/`interrupted`) and
 * `backtracked` are not reconstructable from run events alone; `BuildPanel`'s
 * own event feed is already a stub with no host route (see its `loadEvents`),
 * so this is a narrower, not a new, gap. `terminalReason` is dropped for the
 * same reason. Filed as CL-8511 for a follow-up once the ledger read itself
 * moves off `apps/hub/src/runs.ts`.
 *
 * `carriedTurns` (turns carried in from another project instance on import)
 * rode `GET /projects/:id` off `command-ledger.ts` too, and has no run-event
 * equivalent; it reads empty here until project-transfer gets its own fold.
 */
import type { Transport } from "@intx/hub-client";
import { requireProject as installerRequireProject, resolveWorkspace, workflowsFor } from "@solutions-builder/installer";
import { currentDeployment } from "./project-list.ts";
import { positionOfSignal } from "@solutions-builder/app/workflows/stage-loop";
import { projectState } from "@solutions-builder/app/project-state";
import { requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import type { Stage } from "@solutions-builder/app/ledger";
import { createHubTransport } from "./hub.ts";
import { artifactGraphFor } from "./artifact-graph.ts";
import { foldOpening, foldProjectRuns, projectApprovals, type StageStatus } from "./run-fold.ts";
import type { ArtifactNode, ProjectDetail, Run } from "./client.ts";

type Page<T> = { data: T[]; nextCursor: string | null };

async function hubList<T>(transport: Transport, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page: Page<T> = await transport.fetch<Page<T>>(
      "GET",
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

type HubPrincipal = { id: string; tenantId: string; kind: string; refId: string; status: string; roles: { id: string; name: string }[] };
type Membership = { principalId: string; tenantId: string; kind: string; status: string };

/**
 * Whether the signed-in actor is the only person in this project tenant who
 * could approve this stage — the same rule as the deleted host route's
 * `apps/hub/src/command-approvals.ts`'s `soloApprovalFor`, over the same
 * `@corbits/*` tenant-membership routes, reachable from the browser the same
 * way every other tenant read in this file is.
 */
async function soloApprovalFor(transport: Transport, projectId: string, stage: Stage): Promise<boolean> {
  const required = requiredAuthorityFor(stage);
  const [mine, members] = await Promise.all([
    hubList<Membership>(transport, "/api/me/principals"),
    hubList<HubPrincipal>(transport, `/api/tenants/${projectId}/principals`),
  ]);
  const actor = mine.find((entry) => entry.tenantId === projectId && entry.kind === "user" && entry.status === "active")?.principalId ?? null;
  return !members.some(
    (row) => row.id !== actor && row.kind === "user" && row.status === "active" && row.roles.some((role) => role.name === required),
  );
}

/** The command-state string the stage workspace actually branches on, folded from `standing`. */
function currentStateFrom(standing: StageStatus | null): string {
  if (standing === null || !standing.parked) return "in_progress";
  const position = positionOfSignal(standing.stage, standing.signalName ?? "");
  if (position?.at === "gate") return standing.stage === 7 ? "cost_approved" : "waiting_approval";
  return "in_progress";
}

function currentRunFrom(anchorRunId: string | null, standing: StageStatus | null): Run | null {
  if (anchorRunId === null) return null;
  return {
    id: anchorRunId,
    kind: "stage",
    stage: standing?.stage ?? 1,
    state: currentStateFrom(standing),
    createdAt: new Date(0).toISOString(),
    endedAt: null,
    terminalReason: null,
    packetId: null,
  };
}

/** Maps an `ArtifactGraphNode` fold onto the `ArtifactNode` shape the pages already consume. */
export function toArtifactNode(node: Awaited<ReturnType<typeof artifactGraphFor>>["nodes"][number]): ArtifactNode {
  const version = Number(node.versionId.slice(node.versionId.lastIndexOf("@") + 1));
  return {
    id: node.id,
    kind: node.kind,
    variant: node.variant,
    stage: node.stage,
    title: node.title,
    version,
    // `@corbits/artifacts` revises an artifact in place; there is no separate
    // node-vs-artifact id any more, so this is the same id `node.id` is.
    artifactId: node.id,
    // No cryptographic hash rides the mounted module's list metadata (CL-8500
    // decision 3) — `versionId` (`<artifactId>@<version>`) is the closest
    // stand-in: unique to this exact version, which is all a gate signal or a
    // decisions-queue display actually needs it for.
    contentHash: node.versionId,
    sizeBytes: 0,
    ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
    createdAt: node.createdAt,
    supersededByNodeId: node.supersededByNodeId,
    provenance: node.provenance,
  };
}

export async function loadProjectView(projectId: string, transport: Transport = createHubTransport()): Promise<ProjectDetail> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const [project, graph, deployments] = await Promise.all([
    installerRequireProject(transport, projectId),
    artifactGraphFor(transport, workspace.tenantId, projectId),
    workflowsFor(transport, projectId).deployments(),
  ]);
  const anchorRunId = currentDeployment(deployments)?.id ?? null;
  const nodes = graph.nodes.map(toArtifactNode);

  const runs = anchorRunId ? await foldProjectRuns(projectId, anchorRunId, transport) : [];
  const standing = projectState(runs);
  const current = currentRunFrom(anchorRunId, standing);

  const [opening, soloApproval] = await Promise.all([
    anchorRunId ? foldOpening(projectId, anchorRunId, transport) : Promise.resolve(null),
    current ? soloApprovalFor(transport, projectId, current.stage as Stage).catch(() => true) : Promise.resolve(true),
  ]);
  const approvals = projectApprovals(runs).map((approval, index) => ({
    id: `${approval.runId}:${index}`,
    runId: approval.runId,
    stage: approval.stage,
    command: approval.command,
    decision: approval.decision,
    audienceName: approval.audienceName,
    rationale: approval.rationale,
    createdAt: approval.at ?? "",
    versions: approval.versions,
  }));

  return {
    project: {
      id: project.id,
      title: project.title,
      policy: project.policy,
      archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
      tenantId: workspace.tenantId,
      anchorRunId,
    },
    tenantId: workspace.tenantId,
    anchorRunId,
    runs: current ? [current] : [],
    current,
    soloApproval,
    nodes,
    approvals,
    opening,
    carriedTurns: [],
  };
}
