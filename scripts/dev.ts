/**
 * Development launcher.
 *
 *   bun run dev                 host from source, interface rebuilt on edit, opens a browser
 *   bun run dev:desktop         the same host inside the Tauri window
 *   bun run dev:fresh           the desktop app on a workspace that has never been used
 *
 * The packaged app runs a compiled sidecar; in development that would mean
 * recompiling the host on every backend edit. Instead this builds the interface
 * once, keeps rebuilding it in the background, and runs the host from source.
 * The host exposes a change stream at `/api/dev/reload` when
 * `SOLUTIONS_BUILDER_DEV_RELOAD` is set, and `main.tsx` subscribes to it in
 * development bundles, so the page reloads itself when a build lands. Editing
 * `apps/hub/src/**` still needs a restart, because that is the process being run.
 *
 * Ctrl-C here ends everything, the host included. The debug shell keeps the
 * development host in this terminal's process group and tells it the shell's
 * pid, so a rebuild that kills the window cannot leave a host behind holding
 * the workspace. A packaged app's host is detached and outlives its window.
 *
 * `--fresh` points the host at a new temporary directory rather than deleting
 * anything: a development workspace is still somebody's work. The directory is
 * printed so it can be reused with `SOLUTIONS_BUILDER_DATA_DIR=…`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_COMMAND } from "./host-command";

const root = join(import.meta.dir, "..");
const desktop = process.argv.includes("--desktop");
const fresh = process.argv.includes("--fresh");

const env: Record<string, string | undefined> = {
  ...process.env,
  SOLUTIONS_BUILDER_DIST_DIR: join(root, "apps", "web", "dist"),
  // Mounts the change stream, and only here; a packaged app never sets it.
  SOLUTIONS_BUILDER_DEV_RELOAD: "1",
};
if (fresh) {
  env.SOLUTIONS_BUILDER_DATA_DIR = await mkdtemp(join(tmpdir(), "solutions-builder-fresh-"));
  console.log(`A new workspace: ${env.SOLUTIONS_BUILDER_DATA_DIR}\n`);
}

function run(command: string[], cwd = root) {
  return Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit", env });
}

// Development mode, so `import.meta.env.DEV` is true and the reload client is
// compiled in. `bun run ui:build` stays a production build.
const UI_BUILD = ["bunx", "vite", "build", "-c", join(root, "apps", "web", "vite.config.ts"), "--mode", "development"];

console.log("Building the interface…");
if ((await run(UI_BUILD).exited) !== 0) {
  console.error("The interface build failed; not starting the host.");
  process.exit(1);
}
const watcher = run([...UI_BUILD, "--watch"]);

let status: number;
if (desktop) {
  // The debug Rust host honours SOLUTIONS_BUILDER_HOST_COMMAND and runs the
  // host from source instead of the compiled sidecar. Bundled resources are
  // disabled because the watcher rewrites `dist/` with new hashed filenames
  // while cargo is still compiling. The sidecar entry is disabled because
  // Tauri's build script insists the binary exists even in `dev`, and a fresh
  // checkout has never run `sidecar:build`; the shell resolves the sidecar by
  // path at runtime, so nothing else depends on the entry here.
  env.SOLUTIONS_BUILDER_HOST_COMMAND = HOST_COMMAND.join(" ");
  console.log("Starting the desktop host…\n");
  status = await run([
    "bunx",
    "@tauri-apps/cli@2",
    "dev",
    "--config",
    JSON.stringify({ bundle: { resources: null, externalBin: null } }),
  ], join(root, "apps", "desktop")).exited;
} else {
  console.log("Starting the host…\n");
  status = await run([...HOST_COMMAND, "--open"]).exited;
}

watcher.kill();
process.exit(status);
