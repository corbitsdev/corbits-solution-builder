/**
 * What this app is, for whoever installs it into a tenant.
 *
 * The hub compares what a tenant holds against this: the version, and the
 * workflow definitions the install must have produced. A tenant missing any of
 * them, or installed from an older version, is stale and gets installed again.
 */
import { PROJECT_LIFECYCLE_ID } from "./workflows/project-lifecycle.js";

export const APP_ID = "solutions-builder";

/** Kept equal to package.json's version; `smoke:kit` fails when it drifts. */
export const APP_VERSION = "0.1.0";

/**
 * Every workflow definition name an installed tenant carries: the lifecycle
 * anchor the command ledger's session keys on. Everything a run actually
 * does is deployed per project (`ensureLifecycleDeployment`), not registered
 * here.
 */
export function expectedDefinitions(): string[] {
  return [PROJECT_LIFECYCLE_ID];
}
