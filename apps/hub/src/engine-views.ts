/**
 * RunView shaping — turning a run record into the guard's `RunView`, and the
 * scoped lookup by run id that every command starts from.
 */
import type { RunView } from "./guard.js";
import { notFound } from "./errors.js";
import { readRun, type RunRecord } from "./runs.js";

export function toRunView(record: RunRecord): RunView {
  return {
    id: record.id,
    kind: record.kind,
    stage: record.stage,
    state: record.state,
    originId: record.originId,
    routeTargetStage: record.routeTargetStage,
    costApprovalVersionId: record.costApprovalVersionId,
    checkpointRef: record.checkpointRef,
  };
}

export async function loadRun(runId: string, projectId: string): Promise<RunView> {
  // Scoped lookup: a run in another project is not found, not forbidden.
  const record = await readRun(runId, projectId);
  if (!record) throw notFound("That run");
  return toRunView(record);
}
