/**
 * Project list: tenants under the workspace tenant, read straight off the
 * hub -- no host DB read.
 *
 * Name and created date come off the project's own tenant row
 * (`listProjectRecords`, already the hub's `GET /api/tenants?parentId=`).
 * Where each stands comes off the run fold the rest of the client already
 * uses (`./run-fold.ts`), against the project tenant's own lifecycle
 * deployment. This is a coarser read than the host's `/projects` route: it
 * has no ledger-titled wait to show, so `needsDecision` is just "parked at a
 * gate" and `waits` stays empty. Project detail (`/projects/:id`) still
 * comes from the host for now.
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, resolveWorkspace, workflowsFor, type HubDeployment } from "@solutions-builder/installer";
import { positionOfSignal } from "@solutions-builder/app/workflows/stage-loop";
import type { ProjectSummary } from "./client.ts";
import { createHubTransport } from "./hub.ts";
import { foldProject } from "./run-fold.ts";

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

/** The deployment a project's run is folded against: the live one, or the newest if none is live. */
function currentDeployment(deployments: readonly HubDeployment[]): HubDeployment | null {
  if (deployments.length === 0) return null;
  const live = deployments.filter((deployment) => !ENDED_DEPLOYMENT_STATUSES.has(deployment.status));
  const pool = live.length > 0 ? live : deployments;
  return [...pool].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]!;
}

/** Every project tenant under the workspace, folded from its own lifecycle deployment. */
export async function listProjectSummaries(transport: Transport = createHubTransport()): Promise<ProjectSummary[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = await listProjectRecords(transport, workspace.tenantId);
  return Promise.all(
    records.map(async (record): Promise<ProjectSummary> => {
      const deployments = await workflowsFor(transport, record.id).deployments();
      const deployment = currentDeployment(deployments);
      const status = deployment ? await foldProject(record.id, deployment.id, transport) : null;
      const position = status?.parked && status.signalName ? positionOfSignal(status.stage, status.signalName) : null;
      const turn: ProjectSummary["turn"] =
        status === null ? "idle" : !status.parked ? "writing" : position?.at === "round" ? "question" : "approve";
      return {
        id: record.id,
        revision: record.revision,
        title: record.title,
        stage: status?.stage ?? null,
        state: status ? (status.parked ? "waiting" : "running") : null,
        runId: deployment?.id ?? null,
        archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
        needsDecision: status?.parked ?? false,
        waits: [],
        turn,
      };
    }),
  );
}
