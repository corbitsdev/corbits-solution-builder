/**
 * The artifact kinds a specialist's own tools write. Spelled here, once,
 * because `publish_workspace` (`@solutions-builder/tools-delivery`) runs in a
 * sidecar with no `apps/web` and no `@solutions-builder/app`; the app's
 * `artifacts.ts` re-exports these beside every other kind the interface reads.
 */

/** The kind stage 8's build archive is recorded under. */
export const BUILD_EVIDENCE_KIND = "build_evidence";

/** The kind stage 8's `publish_workspace` records its companion delivery
 *  manifest under — the per-file path/sha256/size list, with the tool's own
 *  verification, that stage 9's opening mail is built from (CL-8723
 *  follow-up, #129). Distinct from stage 9's own `delivery_manifest` draft
 *  kind by `sb.stage` (8, not 9): this is evidence stage 8 produced, not
 *  stage 9's own document. */
export const DELIVERY_MANIFEST_KIND = "delivery_manifest";
