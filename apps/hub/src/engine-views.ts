/**
 * RunView shaping — turning the executor's `StoredRun` into the guard's
 * `RunView`, and the scoped lookup by run id that every command starts from.
 */
import type { RunView } from "./guard.js";
import { notFound } from "./errors.js";
import { getRunRecord, type StoredRun } from "./hub-executor.js";

export function toRunView(record: StoredRun): RunView {
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

export function loadRun(runId: string, projectId: string): RunView {
  const record = getRunRecord(runId);
  // Scoped lookup: a run in another project is not found, not forbidden.
  if (!record || record.projectId !== projectId) throw notFound("That run");
  return toRunView(record);
}
