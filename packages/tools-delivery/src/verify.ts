/**
 * The deterministic delivery checks live in
 * `@solutions-builder/specialist-runtime/verify`, below any agent runtime,
 * so the host's build route and this package's sidecar tool run the same
 * ones. Re-exported here for the tool and its tests.
 */
export * from "@solutions-builder/specialist-runtime/verify";
