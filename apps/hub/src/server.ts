/**
 * The Solution Builder host.
 *
 * The process skeleton — loopback port, session token and handshake, pglite,
 * the embedded hub mount, SPA serving, drain — is `@solutions-builder/host`'s
 * runtime, `@corbits/embedded-host`. What this file owns is only
 * the product composition: the identity (`identity.ts`), this product's
 * routes (`api.ts`), and where this checkout keeps its built interface.
 *
 * Boot ends when the runtime reports ready. Everything that makes this
 * tenant Solution Builder — the user principal, workflow definitions,
 * roles, specialist prompts — is installed by the client through
 * `@solutions-builder/installer`, not on every boot.
 */
import { dirname, join } from "node:path";
import { serveHost } from "@corbits/embedded-host";
import { initSolutionsBuilderHost } from "./identity.js";
import { API_VERSION, createApi } from "./api.js";

initSolutionsBuilderHost();

await serveHost({
  api: createApi(),
  apiVersion: API_VERSION,
  distDirs: [
    // What the desktop shell passes (Tauri bundles `dist/` as a resource),
    // a `dist/` beside the executable for a standalone binary, and the web
    // app's own `dist/` for `bun run dev`.
    process.env.SOLUTIONS_BUILDER_DIST_DIR?.trim(),
    join(dirname(process.execPath), "dist"),
    join(import.meta.dir, "..", "..", "web", "dist"),
  ].filter((dir): dir is string => Boolean(dir)),
});
