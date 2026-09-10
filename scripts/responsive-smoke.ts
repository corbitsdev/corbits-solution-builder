/**
 * Responsive smoke: the page must never scroll sideways.
 *
 * Wide content — a table, the stage timeline — scrolls inside its own panel.
 * The page does not. A grid item's floor is its intrinsic width, so a single
 * missing `min-width: 0` pushes the whole layout past the screen, and it is
 * invisible on a desktop.
 *
 * Measured in a real browser rather than read off the stylesheet, because the
 * failure is a layout outcome and not a rule anyone would write on purpose.
 *
 * Note on widths: Chrome's headless viewport has a 500px floor, so 500 is the
 * narrowest honest measurement here. A screenshot requested below that renders
 * at 500 and crops, which reads as a broken layout when nothing is broken.
 *
 * Usage: bun scripts/responsive-smoke.ts   (needs a built dist and a host)
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = [500, 768, 1024, 1440];
const VIEWS = ["decisions", "projects", "workspace", "settings"];

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

if (!(await Bun.file(CHROME).exists())) {
  console.log("SKIP  responsive smoke - Chrome is not installed");
  process.exit(0);
}

const index = join(root, "dist", "index.html");
if (!(await Bun.file(index).exists())) {
  console.log("SKIP  responsive smoke - no built interface (run `bun run ui:build`)");
  process.exit(0);
}

// The probe is served as a file: the host's CSP allows `script-src 'self'` and
// deliberately refuses inline script, which is the correct behaviour to keep.
const probe = `window.addEventListener("load", function () {
  setTimeout(function () {
    var doc = document.documentElement;
    document.title = "R " + doc.clientWidth + " " + doc.scrollWidth;
  }, 2000);
});`;

const dataDir = await mkdtemp(join(tmpdir(), "sb-responsive-"));
const original = await readFile(index, "utf8");
await writeFile(join(root, "dist", "probe.js"), probe);
await writeFile(index, original.replace("</body>", '<script src="/probe.js"></script></body>'));

const host = Bun.spawn(
  // No fixed port: a dev host or a leftover process holding it made this gate
  // probe someone else's server and report "the probe did not run" — a flake
  // that looked like a layout failure. The host picks a port and says which.
  ["bun", "--conditions", "intx-src", join(root, "src", "host", "server.ts"), "--port", "0"],
  { cwd: root, env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" },
);

try {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let token = "";
  let port = "";
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && !token) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const launch = /launch URL: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9-]+)/.exec(buffer);
    port = launch?.[1] ?? "";
    token = launch?.[2] ?? "";
  }
  reader.releaseLock();
  if (!token) throw new Error("the host did not become ready");

  for (const width of WIDTHS) {
    for (const view of VIEWS) {
      const child = Bun.spawn(
        [
          CHROME, "--headless", "--disable-gpu", "--no-sandbox",
          `--window-size=${width},900`, "--virtual-time-budget=8000", "--dump-dom",
          `http://127.0.0.1:${port}/?token=${token}&view=${view}`,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const html = await new Response(child.stdout).text();
      await child.exited;

      const measured = /<title>R (\d+) (\d+)<\/title>/.exec(html);
      if (!measured) {
        check(`${view} at ${width}px reports its layout`, false, "the probe did not run");
        continue;
      }
      const client = Number(measured[1]);
      const scroll = Number(measured[2]);
      check(
        `${view} at ${width}px does not scroll sideways`,
        scroll <= client,
        scroll > client ? `scrollWidth ${scroll} > clientWidth ${client}` : "",
      );
    }
  }
} finally {
  host.kill();
  await writeFile(index, original);
  await rm(join(root, "dist", "probe.js"), { force: true });
  await rm(dataDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nResponsive smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
