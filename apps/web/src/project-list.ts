/**
 * Project list: tenants under the workspace tenant, read straight off the
 * hub -- no host DB read.
 *
 * Name and created date come off the project's own tenant row
 * (`listProjectRecords`, folded from the caller's own memberships over
 * `GET /api/me/principals`, the same as workbench). Where each stands comes
 * off the same artifact-graph cursor `./project-view.ts` derives for a
 * single project (CL-8612 contract v6): no lifecycle run, so `needsDecision`
 * is "a stock hub approval is pending on this project" and `turn` stays
 * `"idle"` — telling whether the specialist is mid-draft would mean polling
 * every project's mailbox on every list refresh, which this list does not do.
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, resolveWorkspace } from "@solutions-builder/installer";
import type { ProjectSummary } from "./client.ts";
import { createHubTransport } from "./hub.ts";
import { artifactGraphFor } from "./artifact-graph.ts";
import { toArtifactNode, currentStageFromArtifacts } from "./project-view.ts";
import { DELIVER_TOOL_NAME, pendingApprovals } from "./pending-approvals.ts";

/** Every project tenant under the workspace, folded from its own artifact graph. */
export async function listProjectSummaries(transport: Transport = createHubTransport()): Promise<ProjectSummary[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = await listProjectRecords(transport, workspace.tenantId);
  return Promise.all(
    records.map(async (record): Promise<ProjectSummary> => {
      const [graph, approvals] = await Promise.all([
        artifactGraphFor(transport, workspace.tenantId, record.id).catch(() => ({ nodes: [], edges: [] })),
        pendingApprovals(record.id, transport).catch(() => []),
      ]);
      const nodes = graph.nodes.map(toArtifactNode);
      const stage = currentStageFromArtifacts(nodes);
      const needsDecision = approvals.some(
        (approval) => approval.status === "pending" && approval.toolDefinition?.name === DELIVER_TOOL_NAME,
      );
      return {
        id: record.id,
        revision: record.revision,
        title: record.title,
        stage,
        archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
        needsDecision,
        waits: [],
        turn: "idle",
      };
    }),
  );
}
