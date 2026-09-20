/**
 * Project list: tenants under the workspace tenant, read straight off the
 * hub -- no host DB read.
 *
 * Name and created date come off the project's own tenant row
 * (`listProjectRecords`, folded from the caller's own memberships over
 * `GET /api/me/principals`, the same as workbench). Where each stands comes
 * off the same artifact-graph cursor `./project-view.ts` derives for a
 * single project (CL-8612 contract v6): no lifecycle run, so `needsDecision`
 * is "a stock hub approval is pending on one of this project's stage
 * specialists" and `turn` stays `"idle"` — telling whether the specialist is
 * mid-draft would mean polling every project's mailbox on every list
 * refresh, which this list does not do. Specialists deploy into the
 * WORKSPACE tenant, so approvals are read from there and matched back to
 * this project via `listSpecialistDeployments` (same as `decisions-fold.ts`).
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, listSpecialistDeployments, resolveWorkspace } from "@solutions-builder/installer";
import type { ProjectSummary } from "./client.ts";
import { createHubTransport } from "./hub.ts";
import { artifactGraphFor } from "./artifact-graph.ts";
import { toArtifactNode, currentStageFromArtifacts } from "./project-view.ts";
import { pendingApprovals } from "./pending-approvals.ts";

/** Every project tenant under the workspace, folded from its own artifact graph. */
export async function listProjectSummaries(transport: Transport = createHubTransport()): Promise<ProjectSummary[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = await listProjectRecords(transport, workspace.tenantId);
  const pending = (await pendingApprovals(workspace.tenantId, transport).catch(() => [])).filter(
    (approval) => approval.status === "pending",
  );
  return Promise.all(
    records.map(async (record): Promise<ProjectSummary> => {
      const [graph, deployments] = await Promise.all([
        artifactGraphFor(transport, workspace.tenantId, record.id).catch(() => ({ nodes: [], edges: [] })),
        listSpecialistDeployments(transport, workspace.tenantId, record.id).catch(() => []),
      ]);
      const nodes = graph.nodes.map(toArtifactNode);
      const stage = currentStageFromArtifacts(nodes);
      const deploymentIds = new Set(deployments.map((deployment) => deployment.deploymentId));
      const needsDecision = pending.some((approval) => deploymentIds.has(approval.anchorRunId));
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
