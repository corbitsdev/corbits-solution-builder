/**
 * Launch smoke: the desktop app's own startup path.
 *
 * `bun run check` exercises the host in-process, which is why a missing
 * `--conditions intx-src` in the *desktop* host command shipped: the flag is
 * only needed on the path no gate covered. The host started fine everywhere the
 * tests looked, and died on the one path they did not.
 *
 * This runs the command `scripts/dev.ts` hands to the Rust host, and
 * the compiled sidecar when one has been built, asserting each reaches the
 * handshake the desktop host waits for.
 *
 * Usage: bun scripts/launch-smoke.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_COMMAND } from "./host-command";

const root = join(import.meta.dir, "..");
const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

/** The prefix the Rust host waits for. If this changes, both sides must. */
const HANDSHAKE = "Solutions Builder launch URL: ";

async function reachesHandshake(
  command: string[],
  // Tauri passes the interface directory from its resource bundle, so a check
  // that wants to fetch a page has to pass it the same way.
  options: { serveInterface?: boolean } = {},
): Promise<{ ok: boolean; detail: string; origin: string | null; stop: () => void }> {
  const dataDir = await mkdtemp(join(tmpdir(), "sb-launch-"));
  // Port 0 asks the host to bind whatever's free and report back what it
  // picked, so this never depends on - or fights over - a fixed port.
  const child = Bun.spawn([...command, "--port", "0"], {
    cwd: root,
    env: {
      ...process.env,
      SOLUTIONS_BUILDER_DATA_DIR: dataDir,
      ...(options.serveInterface ? { SOLUTIONS_BUILDER_DIST_DIR: join(root, "apps", "web", "dist") } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => {
    child.kill();
    void rm(dataDir, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + 150_000;
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffer = "";
    let found = false;
    try {
      while (Date.now() < deadline && !found) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        found = buffer.includes(HANDSHAKE);
      }
    } finally {
      reader.releaseLock();
    }

    const launch = /launch URL:\s*(\S+)/.exec(buffer)?.[1];
    const origin = found && launch ? new URL(launch).origin : null;
    const stderr = found ? "" : (await new Response(child.stderr).text()).slice(-400);
    const spawnFailed = /EADDRINUSE|address already in use/i.test(stderr);

    if (!options.serveInterface) stop();

    return {
      ok: found,
      detail: found
        ? ""
        : spawnFailed
          ? "port already held by another process"
          : (stderr.split("\n").find((line) => line.includes("error")) ?? "no handshake"),
      origin,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

// The exact command `scripts/dev.ts` hands to the Rust host.
{
  const result = await reachesHandshake(HOST_COMMAND);
  check("the desktop dev host reaches its handshake", result.ok, result.detail);
}

// The compiled sidecar, when one exists. Not built here: compiling on every
// check would make the gate slow enough that people stop running it.
const sidecar = join(
  root,
  "apps",
  "desktop",
  "binaries",
  `solutions-builder-host-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
);
if (await Bun.file(sidecar).exists()) {
  const result = await reachesHandshake([sidecar], { serveInterface: true });
  try {
    check("the compiled sidecar reaches its handshake", result.ok, result.detail);

    // And that it serves the interface, which reaching a handshake does not
    // prove: a binary that boots and then answers 503 for every page is a
    // working host and a broken app. Tauri passes this directory from its
    // resource bundle; the check passes it the same way.
    if (result.ok && result.origin) {
      const page = await fetch(result.origin).catch(() => null);
      const html = page?.ok ? await page.text() : "";
      check(
        "the compiled sidecar serves the interface",
        page?.status === 200 && html.includes("<div id=\"root\""),
        `${page?.status ?? "no response"}`,
      );
      const asset = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
      const script = asset ? await fetch(`${result.origin}/${asset}`).catch(() => null) : null;
      check("and the bundle it links", script?.status === 200, asset ?? "no bundle linked");
    }
  } finally {
    result.stop();
  }
} else {
  console.log("SKIP  compiled sidecar - none built (run `bun run sidecar:build`)");
}

// Live reload, which `bun run dev` depends on and which is invisible
// until it silently stops working: the loop it replaces is "edit, alt-tab,
// reload by hand", and nobody notices a reload that simply never arrives.
{
  const dataDir = await mkdtemp(join(tmpdir(), "solutions-builder-reload-"));
  const child = Bun.spawn(
    ["bun", "--conditions", "intx-src", join(root, "apps", "hub", "src", "server.ts"), "--port", "0"],
    {
      cwd: root,
      env: {
        ...process.env,
        SOLUTIONS_BUILDER_DATA_DIR: dataDir,
        SOLUTIONS_BUILDER_DIST_DIR: join(root, "apps", "web", "dist"),
        SOLUTIONS_BUILDER_DEV_RELOAD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  try {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffer = "";
    try {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline && !/launch URL/.test(buffer)) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const launch = /launch URL:\s*(\S+)/.exec(buffer)?.[1];

    if (!launch) {
      check("the dev host starts with reload enabled", false, buffer.slice(-160));
    } else {
      const origin = new URL(launch).origin;
      const stream = await fetch(`${origin}/api/dev/reload`);
      check(
        "the change stream is served",
        stream.headers.get("content-type")?.includes("event-stream") === true,
        stream.headers.get("content-type") ?? "no content type",
      );

      const events = stream.body!.getReader();
      await events.read();

      // The stimulus repeats. Under the full gate several hosts start at once,
      // and a single write racing the watcher's registration made this fail
      // intermittently — a flaky check is worse than no check, because it
      // teaches people to rerun rather than to look.
      const probe = join(root, "apps", "web", "dist", ".reload-probe");
      const touch = setInterval(() => {
        void writeFile(probe, String(Date.now())).catch(() => {});
      }, 1_000);
      try {
        await writeFile(probe, String(Date.now()));
        const event = await Promise.race([
          events.read().then((result) => decoder.decode(result.value)),
          new Promise<string>((resolve) => setTimeout(() => resolve(""), 20_000)),
        ]);
        check("a rebuild reaches the window", event.includes("rebuilt"), event.trim() || "no event in 20s");
      } finally {
        clearInterval(touch);
        events.releaseLock();
        await rm(probe, { force: true });
      }
    }
  } finally {
    child.kill();
    void rm(dataDir, { recursive: true, force: true });
  }
}

// §3: start-at-login is explicit and reversible, and nothing about installing
// or running the app may turn it on. The marker file is the whole mechanism,
// so its absence on a fresh workspace is the property worth checking — a
// silent opt-in would be invisible until somebody noticed their login items.
{
  const dataDir = await mkdtemp(join(tmpdir(), "solutions-builder-login-"));
  const marker = join(dataDir, "start-at-login");
  const child = Bun.spawn(
    ["bun", "--conditions", "intx-src", join(root, "apps", "hub", "src", "server.ts"), "--port", "0"],
    {
      cwd: root,
      env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffer = "";
    try {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline && !/launch URL/.test(buffer)) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const launch = /launch URL:\s*(\S+)/.exec(buffer)?.[1];

    if (!launch) {
      check("the host starts for the login-item check", false, buffer.slice(-160));
    } else {
      check("starting the app does not opt anybody in", !(await Bun.file(marker).exists()));

      const origin = new URL(launch).origin;
      const token = new URL(launch).searchParams.get("token") ?? "";
      // The handshake answers 302 and sets the session on *that* response, so
      // the redirect must not be followed: fetch consumes it and the cookie with
      // it, and every later request is anonymous.
      const session = await fetch(`${origin}/?token=${token}`, { redirect: "manual" });
      // The name=value pair only. Sending a whole Set-Cookie string sends its
      // attributes as cookies, the request is rejected, and the check then
      // passes for the wrong reason because the marker was never written.
      const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      const on = await fetch(`${origin}/api/preferences/host.startAtLogin`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: "true",
      });
      check(
        "turning it on records the choice",
        on.status === 200 && (await Bun.file(marker).exists()),
        `${on.status}`,
      );

      const off = await fetch(`${origin}/api/preferences/host.startAtLogin`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: "false",
      });
      check(
        "and turning it off removes it",
        off.status === 200 && !(await Bun.file(marker).exists()),
        `${off.status}`,
      );

      // The build worker: Corbits Code until somebody chooses otherwise, the
      // choice reported by the host's status at once, and a tool the bridge
      // cannot drive refused rather than saved.
      const status = async () =>
        (await (await fetch(`${origin}/api/status`, { headers: { cookie } })).json()) as {
          build: { worker: { id: string }; workers: { id: string }[] };
        };
      const before = await status();
      check(
        "the build worker is Corbits Code by default, among the workers on offer",
        before.build.worker.id === "corbits-code" && before.build.workers.length >= 3,
        `${before.build.worker.id}; ${before.build.workers.length} on offer`,
      );
      const chosen = await fetch(`${origin}/api/preferences/build.worker`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify("claude-code"),
      });
      const preferences = (await (await fetch(`${origin}/api/preferences`, { headers: { cookie } })).json()) as {
        preferences: Record<string, unknown>;
      };
      const after = await status();
      check(
        "choosing another worker is saved and reported by the host's status",
        chosen.status === 200 &&
          preferences.preferences["build.worker"] === "claude-code" &&
          after.build.worker.id === "claude-code",
        `${chosen.status}; preference ${String(preferences.preferences["build.worker"])}; status ${after.build.worker.id}`,
      );
      const refused = await fetch(`${origin}/api/preferences/build.worker`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify("some-other-tool"),
      });
      check("a worker the bridge cannot drive is refused", refused.status === 400, `${refused.status}`);
    }
  } finally {
    child.kill();
    void rm(dataDir, { recursive: true, force: true });
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nLaunch smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
