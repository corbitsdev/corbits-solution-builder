/**
 * Where a project's lifecycle run stands, folded in the browser.
 *
 * The host still answers `/projects/:id` with activity it folded itself; the
 * client prefers this read when it has a workspace tenant and an anchor, so
 * "what is happening" comes from the same events the run committed, over
 * `/hub`, rather than from a second copy of the machine. Ledger writes stay
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
