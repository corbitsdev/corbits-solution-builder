/**
 * `loadProjectView`: the project detail read, folded in the browser from the
 * project's own tenant record, its artifact fold, and — when one exists —
 * its native project workflow (what `GET /projects/:id` and
 * `GET /projects/:id/graph` used to answer; CL-8510, step C of CL-8072;
 * design fixed by CL-8500 steps A/#363 and B/#370).
 *
 * The project workflow (CL-8721) is now the process authority: once it
 * exists, its own committed stage is `detail.stage`, not the artifact fold.
 * `currentStageFromArtifacts` below only still applies before the workspace
 * has ensured a workflow for this project (a brand-new project, or one from
 * before the cutover) — see `resolveStage`.
 */
import type { Transport } from "@intx/hub-client";
import { requireProject as installerRequireProject, resolveWorkspace } from "@solutions-builder/installer";
import { requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import type { Stage } from "@solutions-builder/app/ledger";
import { createHubTransport } from "./hub.ts";
import { artifactGraphFor } from "./artifact-graph.ts";
import { STAGE_DRAFT_KIND } from "./client.ts";
import type { ArtifactNode, ProjectDetail } from "./client.ts";
import { resolveProjectWorkflowRef } from "./project-workflow-ref.ts";
import { loadProjectWorkflowView, type ProjectWorkflowView } from "./project-workflow.ts";

const LAST_STAGE = 9;

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
 * 1 + the highest stage with a live, *explicitly approved* draft artifact —
 * the single stage cursor every page shares (`pages/workspace/index.tsx`,
 * `project-list.ts`). Approval is `sb.approvedAt`, stamped only by
 * `persistStageDraft` (the Approve path); a stage's kind existing on an
 * artifact is not enough — a package write, a design feedback revision, or a
 * stakeholder decision never stamps it, so none of those can advance the
 * stage on their own (CL-8639).
 */
export function currentStageFromArtifacts(nodes: readonly ArtifactNode[]): number {
  let stage = 1;
  for (let candidate = 1; candidate <= LAST_STAGE; candidate += 1) {
    const approved = nodes.some(
      (node) =>
        node.stage === candidate &&
        node.kind === STAGE_DRAFT_KIND[candidate] &&
        node.supersededByNodeId === null &&
        node.approvedAt !== null,
    );
    if (!approved) break;
    stage = Math.min(candidate + 1, LAST_STAGE);
  }
  return stage;
}

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

/**
 * `detail.stage` and `detail.done`, resolved from `view` when the project
 * has a workflow, else the artifact-fold fallback — the single stage cursor
 * every page shares (`app.tsx`'s header/rail, `pages/workspace/index.tsx`,
 * `project-list.ts`). `stageSource` lets a caller tell which rule produced
 * it, mainly for tests and debugging; no page branches on it today.
 */
export function resolveStage(
  view: ProjectWorkflowView | null,
  nodes: readonly ArtifactNode[],
): { stage: number; done: boolean; stageSource: "workflow" | "artifacts" } {
  if (!view) return { stage: currentStageFromArtifacts(nodes), done: false, stageSource: "artifacts" };
  return { stage: view.done ? LAST_STAGE : view.stage, done: view.done, stageSource: "workflow" };
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
    // An uploaded file's real size, carried through the fold from
    // `source.upload.size`; unknown rather than a misleading 0 for plain
    // text/data-URL artifacts, whose length the list route cannot see.
    ...(node.sizeBytes !== undefined ? { sizeBytes: node.sizeBytes } : {}),
    ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
    createdAt: node.createdAt,
    supersededByNodeId: node.supersededByNodeId,
    provenance: node.provenance,
    approvedAt: node.approvedAt,
    // The real content digest `@corbits/artifacts` computed for this
    // version, when it recorded one (CL-8723) — real, unlike `contentHash`.
    contentSha256: node.contentSha256 ?? null,
  };
}

export async function loadProjectView(projectId: string, transport: Transport = createHubTransport()): Promise<ProjectDetail> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const [project, graph] = await Promise.all([
    installerRequireProject(transport, projectId),
    artifactGraphFor(transport, workspace.tenantId, projectId),
  ]);
  const nodes = graph.nodes.map((node) => toArtifactNode(node));

  const ref = await resolveProjectWorkflowRef(transport, workspace.tenantId, projectId).catch(() => null);
  const view = ref ? await loadProjectWorkflowView(transport, workspace.tenantId, ref).catch(() => null) : null;
  const { stage, done, stageSource } = resolveStage(view, nodes);

  const soloApproval = await soloApprovalFor(transport, projectId, stage as Stage).catch(() => true);

  return {
    project: {
      id: project.id,
      title: project.title,
      policy: project.policy,
      archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
    },
    tenantId: workspace.tenantId,
    stage,
    done,
    stageSource,
    soloApproval,
    nodes,
    approvals: [],
  };
}
