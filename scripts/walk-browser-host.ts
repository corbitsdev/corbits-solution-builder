/**
 * Boots an isolated Solutions Builder host for `scripts/walk-browser.sh`.
 *
 * Spawns the app's own entry
 * (`apps/hub/src/server.ts`) with `--port 0` (OS-assigned free port, never a
 * fixed one another session might own) and `SOLUTIONS_BUILDER_DATA_DIR`
 * pointed at a caller-supplied directory outside the repo.
 *
 * Prints exactly one line to stdout once ready:
 *   HOST_URL http://127.0.0.1:<port>/?token=<uuid>
 * and nothing else to stdout afterward (host stdout/stderr are drained but
 * not echoed, so a token never lands in a shell's transcript by accident).
 * Stays alive until SIGTERM/SIGINT, then kills the child and exits.
 */
const dataDir = process.env["WALK_HOST_DATA_DIR"];
if (!dataDir) {
  console.error("WALK_HOST_DATA_DIR is required");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const entry = `${root}apps/hub/src/server.ts`;

const child = Bun.spawn(["bun", "--conditions", "intx-src", entry, "--port", "0"], {
  cwd: root,
  env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir },
  stdout: "pipe",
  stderr: "pipe",
});

// WALK_HOST_LOG: where the host's own output goes; without it a failed deploy is invisible.
const hostLog = process.env.WALK_HOST_LOG ? Bun.file(process.env.WALK_HOST_LOG).writer() : null;
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill();
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const deadline = Date.now() + 150_000;
const reader = child.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";
let printed = false;
while (Date.now() < deadline && !printed) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const match = /launch URL: (http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9-]+)/.exec(buffer);
  if (match) {
    console.log(`HOST_URL ${match[1]}`);
    printed = true;
  }
}
if (!printed) {
  console.error("host never reached its handshake within 150s");
  child.kill();
  process.exit(1);
}

// Drain both streams for the rest of the run so the child never blocks on a full pipe.
void (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (hostLog && value) await hostLog.write(value);
    }
  } catch {
    // exiting
  }
})();
void (async () => {
  const stderrReader = child.stderr.getReader();
  try {
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      if (hostLog && value) await hostLog.write(value);
    }
  } catch {
    // exiting
  }
})();

await child.exited;
process.exit(0);
