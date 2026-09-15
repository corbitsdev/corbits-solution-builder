/**
 * Dependency-direction check.
 *
 * The tree is a Bun workspace: `packages/solutions-builder` is the app package
 * (what will be installed into an Interchange tenant), `apps/hub` is the host,
 * `apps/web` is the client. This script is what makes the lines between them
 * true rather than aspirational:
 *
 *   1. The package depends on nothing in `apps/` and on no platform internals.
 *      It may use the workflow authoring surface and the platform's types,
 *      because the definitions it generates are Interchange workflows.
 *   2. Only the hub talks to a provider or an agent runtime, and only the
 *      hub's embedding files (`hub-mount`, `hub-keys`, `hub-migrate`,
 *      `db`, `schema`, `migrate`) plus
 *      `hub-executor` and `hub-gaps` import Interchange internals. A second
 *      module reaching into the hub is how a parallel control plane starts.
 *   3. The client cannot write persistence: `apps/web` never imports the hub,
 *      the database, the schema, or the command engine.
 *   4. Run state moves in exactly one place. Only `engine.ts` (and
 *      `projects.ts`, opening the first run) records a run mutation on the
 *      ledger, so there is no second state machine.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const PACKAGE = "packages/solutions-builder/src";
const HUB = "apps/hub/src";
const WEB = "apps/web/src";

type Violation = { file: string; rule: string; detail: string };
const violations: Violation[] = [];

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return ["node_modules", "dist"].includes(entry.name) ? [] : walk(path);
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

const startsWithAny = (name: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}/`) || name.startsWith(prefix));

/**
 * Provider SDKs and agent runtimes. Only the hub may reach these: a provider
 * call inside the package or the client is exactly the coupling forbidden.
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
 * The Interchange platform's internals: the hub, its database and its
 * identity. Infrastructure the host mounts and owns, not a provider it talks
 * to, so it belongs to the hub's platform files and nowhere else.
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

/** The runtime surface the hub's product code may use without being a platform file. */
const RUNTIME_PACKAGES = [
  "@intx/inference",
  "@intx/inference-catalog",
  "@intx/agent",
  "@intx/types",
  "@intx/workflow",
  "@intx/hub-client",
];

/**
 * What the app package may take from the platform: authoring, not internals.
 *
 * `pptxgenjs` and `jszip` are deck authoring's own libraries — deterministic,
 * offline document generation, not a provider SDK or an agent runtime — so
 * they belong beside the tool that uses them (`deck.ts`, `deck-on-template.ts`)
 * rather than in the hub. They are still hub-invoked today (CL-8006's
 * intermediate step); once that tool ships as a workflow-closure member
 * (`workflow-closure.ts`) resolved via its own npm entries instead of the
 * hub's local `node_modules`, this allowance moves with it.
 */
const PACKAGE_ALLOWED = ["@intx/workflow", "@intx/types", "arktype", "pptxgenjs", "jszip"];

const PLATFORM_FILE = /^apps\/hub\/src\/(hub-mount|hub-keys|hub-migrate|hub-executor|hub-gaps|db|schema|migrate)\.ts$/;

const files = (await Promise.all([PACKAGE, HUB, WEB].map((area) => walk(join(root, area))))).flat();

for (const file of files) {
  const path = relative(root, file);
  const text = await readFile(file, "utf8");
  const imports = importsOf(text);
  const area = path.startsWith(PACKAGE) ? "package" : path.startsWith(HUB) ? "hub" : "web";
  const external = imports.filter((name) => !name.startsWith("."));

  if (area === "package") {
    const outside = external.filter(
      (name) => !startsWithAny(name, PACKAGE_ALLOWED) && !name.startsWith("node:"),
    );
    if (outside.length > 0) {
      violations.push({
        file: path,
        rule: "the app package depends on nothing outside itself, the workflow authoring surface and the platform's types",
        detail: outside.join(", "),
      });
    }
  }

  if (area !== "hub") {
    const provider = external.filter((name) => startsWithAny(name, PROVIDER_PACKAGES));
    if (provider.length > 0) {
      violations.push({
        file: path,
        rule: "only apps/hub may import a provider or agent runtime",
        detail: provider.join(", "),
      });
    }
  }

  // The platform is mounted in one place.
  {
    const platform = external.filter((name) => startsWithAny(name, PLATFORM_PACKAGES));
    const runtimeOnly = platform.every((name) => startsWithAny(name, RUNTIME_PACKAGES));
    // `@intx/types` sits in both lists: it is a platform package (its home is
    // vendor/interchange) and the one the app package rule above already
    // names as allowed, because they are types, not internals. Without this
    // clause the two rules contradict each other and no package file could
    // ever import it.
    const packageAllowed = area === "package" && platform.every((name) => startsWithAny(name, PACKAGE_ALLOWED));
    const allowed = PLATFORM_FILE.test(path) || (area === "hub" && runtimeOnly) || packageAllowed;
    if (platform.length > 0 && !allowed) {
      violations.push({
        file: path,
        rule: "only the hub's embedding files, hub-executor and hub-gaps may import the Interchange platform",
        detail: platform.join(", "),
      });
    }
  }

  if (area === "web") {
    const forbidden = imports.filter(
      (name) =>
        name.includes("apps/hub") ||
        name.includes("@solutions-builder/hub") ||
        name.startsWith("drizzle-orm") ||
        name.includes("@electric-sql/pglite") ||
        name.includes("@intx/"),
    );
    if (forbidden.length > 0) {
      violations.push({
        file: path,
        rule: "the client never imports the hub or writes persistence",
        detail: forbidden.join(", "),
      });
    }
  }

  // The single-state-machine rule. A run's record is folded from the run
  // mutations on the ledger thread (`runs.ts`), and only `engine.ts` records
  // them; `projects.ts` opens the first run when a project is created, which
  // is the one write the engine does not make. Anywhere else is a second
  // state machine starting.
  const STATE_WRITERS = [`${HUB}/engine.ts`, `${HUB}/projects.ts`];
  if (!STATE_WRITERS.includes(path) && /\bnew RunDraft\s*\(|\bop: "create"|\bop: "patch"/.test(text) && path !== `${HUB}/runs.ts`) {
    violations.push({
      file: path,
      rule: "only apps/hub/src/engine.ts and apps/hub/src/projects.ts move a run's state",
      detail: "records run mutations",
    });
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
