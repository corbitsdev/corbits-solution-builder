/**
 * Stage identifiers a few readers still need now that the lifecycle workflow
 * and its chat/approve-chain rendering are gone (see `project-state.ts`'s
 * event fold, `seed-kit.ts`'s director grouping, and `manifest.ts`'s app id).
 * Kept as plain constants and lookups, independent of any workflow
 * definition, so deleting the definition-building code does not touch these
 * readers.
 */
import type { Stage } from "../ledger.js";

export const STAGE_WORKFLOW_ID = "solutions-builder.stage";
export const PROJECT_LIFECYCLE_ID = "solutions-builder.project-lifecycle";

/** The naming agent step's id, as it appeared on a run's own step map. */
export const NAME_STEP_ID = "name";

const FREEZE_STAGE: Stage = 7;
const BUILD_STAGE: Stage = 8;
const DELIVERY_STAGE: Stage = 9;
const FREEZE_STEP_ID = "freeze";
const EVIDENCE_STEP_ID = "evidence";
const DELIVERY_STEP_ID = "delivery-check";

/** The stage a signal name of this shape belongs to, or null for any other name. */
export function stageOfSignal(signalName: string): Stage | null {
  const match = new RegExp(`^${STAGE_WORKFLOW_ID.replace(/\./g, "\\.")}\\.([1-9])\\.`).exec(signalName);
  return match ? (Number(match[1]) as Stage) : null;
}

/** The stage a top-level step id of this shape belongs to, or null otherwise. */
export function stageOfStepId(stepId: string): Stage | null {
  if (stepId === FREEZE_STEP_ID) return FREEZE_STAGE;
  if (stepId === EVIDENCE_STEP_ID) return BUILD_STAGE;
  if (stepId === DELIVERY_STEP_ID) return DELIVERY_STAGE;
  const match = /^gate-(\d)$/.exec(stepId);
  return match ? (Number(match[1]) as Stage) : null;
}
