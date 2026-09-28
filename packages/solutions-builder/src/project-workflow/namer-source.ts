import type { InferenceSourcePin } from "../specialist-source.js";

/**
 * The inference source the `name` step's agent declares. A deployed project
 * workflow never runs this module: `scripts/project-workflow-pack.ts` leaves
 * the import external and the installer writes the tenant's own pin beside
 * `workflow.js` (`namerSourceModule`). In process nothing is pinned, so the
 * step fails into `nameFailed` and the project keeps its fallback title.
 */
export const NAMER_SOURCE: InferenceSourcePin = { provider: "unpinned", model: "unpinned" };
