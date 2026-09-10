/**
 * Dependency-direction check — BUILD_PLAN_V3 sections 1 and 3.
 *
 * The plan draws three lines. This script is what makes them true rather than
 * aspirational, in the spirit of the Alpha spike's `check-boundaries`:
 *
 *   1. Domain logic contains no provider SDK calls. Only `orchestration/`
 *      talks to a provider or to `@intx/*`.
 *   2. Clients cannot write persistence. `ui/` never imports the database,
 *      the schema, or the command engine.
 *   3. Contracts depend on nothing. `contracts/` is the root of the graph.
 *   4. Run state moves in exactly one place. Only `engine.ts` (and
 *      `store/projects.ts`, opening the first run) writes a run's state,
 *      through the executor's `StoredRun`, so there is no second state
 *      machine.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "src");

type Violation = { file: string; rule: string; detail: string };
const violations: Violation[] = [];

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
    }),
  );
  return files.flat();
}

const IMPORT = /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm;
// A dynamic import reaches the same package as a static one. Checking only the
// static form let `await import("@intx/db/schema")` cross a boundary this gate
// exists to hold.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(text: string): string[] {
  return [IMPORT, DYNAMIC_IMPORT, REQUIRE].flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => match[1] ?? ""),
  );
}

/**
 * Provider SDKs and agent runtimes. Only `orchestration/` may reach these: a
 * provider call inside domain logic is exactly the coupling section 3 forbids.
 *
 * The platform's own inference runtime is deliberately NOT on this list: using
 * it is the goal, and forbidding it is what produced a second one.
 */
const PROVIDER_PACKAGES = [
  "openai",
  "@anthropic-ai/",
  "ollama",
  "@corbits/code",
  "@corbits/codex-provider",
  "@corbits/xai-provider",
  "@corbits/oauth-core",
];

/**
 * The Interchange platform: the hub, its database and its identity. This is
 * infrastructure the host mounts and owns, not a provider it talks to, so it
 * belongs to `host/hub/` — and nowhere else, because a second module reaching
 * into hub internals is how a parallel control plane starts.
 */
const PLATFORM_PACKAGES = [
  "@intx/db",
  "@intx/hub-api",
  "@intx/hub-sessions",
  "@intx/hub-common",
  "@intx/hub-client",
  "@intx/crypto",
  "@intx/authz",
  "@intx/log",
  "@intx/types",
  "@intx/mailbox",
  "@intx/storage-isogit",
];

const files = await walk(source);

for (const file of files) {
  const path = relative(root, file);
  const text = await readFile(file, "utf8");
  const imports = importsOf(text);
  const area = path.startsWith("src/contracts")
    ? "contracts"
    : path.startsWith("src/orchestration")
      ? "orchestration"
      : path.startsWith("src/ui")
        ? "ui"
        : "host";

  if (area === "contracts") {
    const local = imports.filter((name) => name.startsWith("."));
    const outside = local.filter((name) => !name.startsWith("./"));
    if (outside.length > 0) {
      violations.push({
        file: path,
        rule: "contracts depend on nothing outside contracts/",
        detail: outside.join(", "),
      });
    }
  }

  if (area === "host" || area === "contracts") {
    const provider = imports.filter((name) =>
      PROVIDER_PACKAGES.some((prefix) => name.startsWith(prefix)),
    );
    if (provider.length > 0) {
      violations.push({
        file: path,
        rule: "only orchestration/ may import a provider or agent runtime",
        detail: provider.join(", "),
      });
    }
  }

  // The platform is mounted in one place. `contracts/` never touches it at all.
  {
    const platform = imports.filter((name) =>
      PLATFORM_PACKAGES.some((prefix) => name === prefix || name.startsWith(`${prefix}/`)),
    );
    const mountsTheHub = path.startsWith("src/host/hub/");
    // The inference runtime and its catalog are the provider layer, not hub
    // internals: `orchestration/` is exactly where they belong, and keeping
    // them out was what pushed us into hand-rolling a second one.
    const runtimeOnly = platform.every((name) =>
      ["@intx/inference", "@intx/inference-catalog", "@intx/agent", "@intx/types"].some(
        (prefix) => name === prefix || name.startsWith(`${prefix}/`),
      ),
    );
    if (platform.length > 0 && !mountsTheHub && !(area === "orchestration" && runtimeOnly)) {
      violations.push({
        file: path,
        rule: "only src/host/hub/ may import the Interchange platform",
        detail: platform.join(", "),
      });
    }
  }

  if (area === "ui") {
    const forbidden = imports.filter(
      (name) =>
        name.includes("db/client") ||
        name.includes("db/schema") ||
        name.includes("host/engine") ||
        name.startsWith("drizzle-orm") ||
        name.includes("@electric-sql/pglite"),
    );
    if (forbidden.length > 0) {
      violations.push({
        file: path,
        rule: "clients never write persistence",
        detail: forbidden.join(", "),
      });
    }
  }

  // The single-state-machine rule. There is no `run` table any more — a
  // project's stage and state live in the runtime executor's in-memory
  // `StoredRun`, and `putRunRecord`/`updateRunRecord` (both defined in
  // `src/host/hub/executor.ts`) are the only ways to write one. Only
  // `engine.ts` moves a run through the ledger; `store/projects.ts` opens the
  // first run when a project is created, which is the one write the engine
  // does not make — everywhere else calling either function is a second state
  // machine starting.
  const STATE_WRITERS = ["src/host/engine.ts", "src/host/store/projects.ts", "src/host/hub/executor.ts"];
  if (!STATE_WRITERS.includes(path)) {
    const writesRunRecord = /\b(putRunRecord|updateRunRecord)\s*\(/.test(text);
    if (writesRunRecord) {
      violations.push({
        file: path,
        rule: "only src/host/engine.ts and src/host/store/projects.ts move a run's state",
        detail: "calls putRunRecord/updateRunRecord",
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Boundary violations:\n");
  for (const violation of violations) {
    console.error(`  ${violation.file}\n    ${violation.rule}\n    -> ${violation.detail}\n`);
  }
  process.exit(1);
}

console.log(`Boundaries hold across ${files.length} files.`);
