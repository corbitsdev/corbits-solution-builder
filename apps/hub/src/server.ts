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
import { adoptRunningAttempts, stopBuildAttempts } from "./build-attempts.js";

initSolutionsBuilderHost();

// A build worker an earlier run of this host left running is followed
// again from its files (#783); one that ended while no host was there is
// recorded from them.
void adoptRunningAttempts()
  .then((adopted) => {
    if (adopted > 0) console.log(`Following ${String(adopted)} build attempt${adopted === 1 ? "" : "s"} again from before the host restarted.`);
  })
  .catch((cause: unknown) => console.error("Could not take up earlier build attempts:", cause));

/**
 * Where `@corbits/embed-hub` mounts the run-scoped artifacts API. A deployed
 * specialist's sidecar dials it with the purpose-minted bearer the installer
 * registered for its run, and the mount's own resolver is the authority for
 * that request; it holds no host session and needs none. The path is fixed
 * on the sidecar side (`WORKFLOW_ARTIFACTS_BASE_PATH` in `@corbits/artifacts`'
 * sidecar bundle and in `@solutions-builder/tools-delivery`), so it is named
 * here rather than moved out from under `/api`.
 */
const WORKFLOW_ARTIFACTS_MOUNT_PATH = "/api/workflow-artifacts";

await serveHost({
  api: createApi(),
  apiVersion: API_VERSION,
  selfAuthenticatingPaths: [WORKFLOW_ARTIFACTS_MOUNT_PATH],
  // A build worker the host started runs on past the host's stop, followed
  // again by the next host to start; on Windows it ends with the host.
  onStop: stopBuildAttempts,
  distDirs: [
    // What the desktop shell passes (Tauri bundles `dist/` as a resource),
    // a `dist/` beside the executable for a standalone binary, and the web
    // app's own `dist/` for `bun run dev`.
    process.env.SOLUTIONS_BUILDER_DIST_DIR?.trim(),
    join(dirname(process.execPath), "dist"),
    join(import.meta.dir, "..", "..", "web", "dist"),
  ].filter((dir): dir is string => Boolean(dir)),
});
