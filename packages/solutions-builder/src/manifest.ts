/**
 * What this app is, for whoever installs it into a tenant.
 *
 * The hub compares what a tenant holds against this: the version, and the
 * workflow definitions the install must have produced. A tenant missing any of
 * them, or installed from an older version, is stale and gets installed again.
 */
import { PROJECT_LIFECYCLE_ID } from "./workflows/project-lifecycle.js";
import { STAGE_WORKFLOW_ID } from "./workflows/stage-loop.js";
import {
  APPROVAL_WORKFLOW_ID,
  BUILD_SUPERVISION_WORKFLOW_ID,
  DELIVERY_WORKFLOW_ID,
  DESIGN_FEEDBACK_WORKFLOW_ID,
  PROVIDER_SWITCH_WORKFLOW_ID,
} from "./workflows/concerns.js";
import { STAGES } from "./ledger.js";

export const APP_ID = "solutions-builder";

/** Kept equal to package.json's version; `smoke:kit` fails when it drifts. */
export const APP_VERSION = "0.1.0";

/** Every workflow definition name an installed tenant carries. */
export function expectedDefinitions(): string[] {
  return [
    PROJECT_LIFECYCLE_ID,
    ...STAGES.map((stage) => `${STAGE_WORKFLOW_ID}.${stage}`),
    APPROVAL_WORKFLOW_ID,
    DESIGN_FEEDBACK_WORKFLOW_ID,
    PROVIDER_SWITCH_WORKFLOW_ID,
    BUILD_SUPERVISION_WORKFLOW_ID,
    DELIVERY_WORKFLOW_ID,
  ];
}
