/**
 * Where a project's lifecycle run stands, folded in the browser.
 *
 * `GET /projects/:id` is the ledger, artifacts, and the tenant/anchor this
 * fold addresses. Standing itself is this read: the same events the run
 * committed, over `/hub`, through the app package's fold. Ledger writes stay
 * on the host.
 */
import { listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import { foldRun, projectState, type FoldedRun, type StageStatus } from "@solutions-builder/app/project-state";
import { createHubTransport } from "./hub.ts";

export type { FoldedRun, StageStatus };

/** Every run under the deployment, folded from its committed `/hub` events. */
export async function foldProjectRuns(
  tenantId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<FoldedRun[]> {
  const runIds = await listWorkflowRuns(transport, tenantId, anchorRunId);
  const folded: FoldedRun[] = [];
  for (const runId of runIds) {
    const { events } = await readWorkflowRunEvents(transport, tenantId, anchorRunId, runId);
    folded.push(foldRun(runId, events));
  }
  return folded;
}

/** Where the project's run stands, read from `/hub` events. */
export async function foldProject(
  tenantId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<StageStatus | null> {
  return projectState(await foldProjectRuns(tenantId, anchorRunId, transport));
}

/**
 * Standing for a project GET: fold the hub events the tenant/anchor name.
 * No anchor means the lifecycle is not placed yet, so there is nothing to fold.
 */
export async function standingForProject(
  project: { tenantId: string; anchorRunId: string | null },
  transport: Transport = createHubTransport(),
): Promise<StageStatus | null> {
  if (project.anchorRunId === null) return null;
  return foldProject(project.tenantId, project.anchorRunId, transport);
}

/** A stage step is in flight — the model is writing, not waiting at a gate. */
export function runIsDrafting(standing: StageStatus | null): boolean {
  return standing !== null && standing.parked === false;
}
