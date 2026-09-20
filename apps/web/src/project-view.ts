/**
 * `loadProjectView`: the project detail read, folded in the browser from the
 * project's own tenant record, its artifact fold, and its native project
 * workflow (what `GET /projects/:id` and `GET /projects/:id/graph` used to
 * answer; CL-8510, step C of CL-8072; design fixed by CL-8500 steps A/#363
 * and B/#370).
 *
 * The project workflow (CL-8721) is the ONLY authority on a project's stage
 * and `done`: `detail.stage`/`detail.done` are its own committed state, read
 * straight off `loadProjectWorkflowView`, never derived from the artifact
 * fold (CL-8639/CL-8687 cutover). Before the workspace has ensured a
 * workflow for this project (a brand-new project, no stage has landed yet)
 * `stage` stays at 1 and `done` at false; a workflow that exists but fails
 * to read propagates as a rejected promise rather than a guessed stage.
 */
import type { Transport } from "@intx/hub-client";
import { requireProject as installerRequireProject, resolveWorkspace } from "@solutions-builder/installer";
import { requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import type { Stage } from "@solutions-builder/app/ledger";
import { createHubTransport } from "./hub.ts";
import { artifactGraphFor } from "./artifact-graph.ts";
import type { ArtifactNode, ProjectDetail } from "./client.ts";
import { resolveProjectWorkflowRef } from "./project-workflow-ref.ts";
import { loadProjectWorkflowView } from "./project-workflow.ts";

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
    // The real content digest `@corbits/artifacts` computed for this
    // version, when it recorded one (CL-8723) — real, unlike `contentHash`.
    contentSha256: node.contentSha256 ?? null,
  };
}

/**
 * `detail.stage`/`detail.done`: the project workflow's own committed state
 * when a workflow ref already exists for this project, read straight off
 * `loadProjectWorkflowView` -- a read failure there propagates (the caller
 * reports the status could not be read, never a guessed stage). No ref yet
 * (the workflow has not been ensured for this project, e.g. a brand-new
 * project the workspace has not opened yet) is not a failure: `stage` stays
 * at 1 and `done` at false until `StageWorkspace` ensures and triggers it.
 */
async function workflowStage(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
): Promise<{ stage: number; done: boolean }> {
  const ref = await resolveProjectWorkflowRef(transport, workspaceTenantId, projectId).catch(() => null);
  if (!ref) return { stage: 1, done: false };
  const view = await loadProjectWorkflowView(transport, workspaceTenantId, ref);
  return { stage: view.done ? LAST_STAGE : view.stage, done: view.done };
}

export async function loadProjectView(projectId: string, transport: Transport = createHubTransport()): Promise<ProjectDetail> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const [project, graph] = await Promise.all([
    installerRequireProject(transport, projectId),
    artifactGraphFor(transport, workspace.tenantId, projectId),
  ]);
  const nodes = graph.nodes.map((node) => toArtifactNode(node));

  const { stage, done } = await workflowStage(transport, workspace.tenantId, projectId);

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
    soloApproval,
    nodes,
    approvals: [],
  };
}
