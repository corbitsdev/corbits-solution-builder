/**
 * Dependency-direction check.
 *
 * The tree is a Bun workspace: `packages/solutions-builder` is the app package
 * (what will be installed into an Interchange tenant), `packages/installer` is
 * the installer package (what does the installing, driven by a hub transport
 * the host supplies), `apps/hub` is the host, `apps/web` is the client. This
 * script is what makes the lines between them true rather than aspirational:
 *
 *   1. The app package depends on nothing in `apps/` and on no platform
 *      internals. It may use the workflow authoring surface and the
 *      platform's types, because the definitions it generates are
 *      Interchange workflows.
 *   1a. The installer package depends on nothing in `apps/` either. It may
 *       take `@solutions-builder/app`, `@intx/hub-client` (the transport it
 *       is driven by) and `@intx/types` — never a platform internal, and
 *       never the app package's own wider allowance (`arktype`, deck
 *       authoring's libraries) it has no use for.
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
 *   5. A `packages/tools-*` package (a sidecar-deployed workflow tool bundle,
 *      e.g. `tools-deck`) is bound by the same rule as the app package: it
 *      runs in the workflow sidecar, never the hub, so it depends on nothing
 *      in `apps/` and reaches the platform only through the workflow/agent
 *      authoring surface, `@solutions-builder/app`, and its own authoring
 *      libraries (deck rendering's `pptxgenjs`/`jszip`).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..");
const PACKAGE = "packages/solutions-builder/src";
const INSTALLER = "packages/installer/src";
const HUB = "apps/hub/src";
const WEB = "apps/web/src";
const PACKAGES_ROOT = "packages";

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

/** What every `packages/tools-*` package may take from outside itself
 *  regardless of what it declares: the agent and workflow authoring
 *  surfaces, and the app package it wraps. No `@solutions-builder/hub`, no
 *  `@intx/db`. Beyond this core, each package's own offline authoring
 *  libraries (deck rendering's `pptxgenjs`/`jszip`, say) are read from its
 *  own `package.json` `dependencies` rather than allowed for every tool
 *  package — a library one tool needs is not a license for every other one
 *  to import it too. */
const TOOLS_CORE_ALLOWED = ["@intx/agent", "@intx/workflow", "@intx/types", "@solutions-builder/app"];

/**
 * What the installer package may take from the platform: the transport it is
 * driven by, and types. Not `arktype` or the deck authoring libraries — it
 * generates nothing of its own that needs them — and never a platform
 * internal beyond `@intx/hub-client`'s own public surface.
 */
const INSTALLER_ALLOWED = [
  "@solutions-builder/app",
  "@intx/hub-client",
  "@intx/types",
  // The one seeded definition's type, the same reason the app package allows
  // it: the shape it generates is an Interchange workflow.
  "@intx/workflow",
  // Its tests' runner; not a runtime dependency of the installed package.
  "bun:test",
];

const PLATFORM_FILE = /^apps\/hub\/src\/(hub-mount|hub-keys|hub-migrate|hub-executor|hub-gaps|db|schema|migrate)\.ts$/;

type ToolsPackage = { dir: string; allowed: readonly string[] };

/** Every `packages/tools-*` package's `src/`, discovered rather than
 *  hardcoded so a new sidecar tool package (e.g. `tools-delivery`) is
 *  checked for free, each scoped to its own declared dependencies. */
async function toolsPackages(): Promise<ToolsPackage[]> {
  const entries = await readdir(join(root, PACKAGES_ROOT), { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("tools-")).map((entry) => entry.name);
  return Promise.all(
    names.map(async (name) => {
      const manifest = JSON.parse(await readFile(join(root, PACKAGES_ROOT, name, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      return {
        dir: `${PACKAGES_ROOT}/${name}/src`,
        allowed: [...TOOLS_CORE_ALLOWED, ...Object.keys(manifest.dependencies ?? {})],
      };
    }),
  );
}

const TOOLS_PACKAGES = await toolsPackages();
const TOOLS_DIRS = TOOLS_PACKAGES.map((pkg) => pkg.dir);

const files = (
  await Promise.all([PACKAGE, INSTALLER, HUB, WEB, ...TOOLS_DIRS].map((area) => walk(join(root, area))))
).flat();

for (const file of files) {
  const path = relative(root, file);
  const text = await readFile(file, "utf8");
  const imports = importsOf(text);
  const toolsPackage = TOOLS_PACKAGES.find((pkg) => path.startsWith(pkg.dir));
  const area = path.startsWith(PACKAGE)
    ? "package"
    : path.startsWith(INSTALLER)
      ? "installer"
      : path.startsWith(HUB)
        ? "hub"
        : toolsPackage
          ? "tools"
          : "web";
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

  if (area === "tools" && toolsPackage) {
    // `bun:test` is the test runner, not shipped: `toolsMemberFiles` in
    // `workflow-closure.ts` leaves `*.test.ts` out of what reaches the
    // sidecar, so a test file importing it is not a runtime dependency.
    const isTest = /\.test\.tsx?$/.test(path);
    const outside = external.filter(
      (name) => !startsWithAny(name, toolsPackage.allowed) && !name.startsWith("node:") && !(isTest && name === "bun:test"),
    );
    if (outside.length > 0) {
      violations.push({
        file: path,
        rule: "a tools package depends on nothing in apps/, no @intx/db, only the agent/workflow authoring surface, the app package, and what its own package.json declares",
        detail: outside.join(", "),
      });
    }
    const apps = imports.filter((name) => name.includes("apps/") || name.includes("@solutions-builder/hub"));
    if (apps.length > 0) {
      violations.push({
        file: path,
        rule: "a tools package never imports an app",
        detail: apps.join(", "),
      });
    }
  }

  if (area === "installer") {
    const outside = external.filter(
      (name) => !startsWithAny(name, INSTALLER_ALLOWED) && !name.startsWith("node:"),
    );
    if (outside.length > 0) {
      violations.push({
        file: path,
        rule: "the installer package depends on nothing but @solutions-builder/app, @intx/hub-client and @intx/types",
        detail: outside.join(", "),
      });
    }
    // A relative import cannot walk out of the package into `apps/`: that is
    // the same escape the app package rule above forbids by name, just spelled
    // with dots instead of a bare specifier. Resolved to an absolute path
    // against the repo root rather than string-matched on the joined
    // (unresolved) path, so `../../../apps/hub/src/x.js` — which never
    // contains a literal "/apps/" segment in its raw, un-normalised join
    // when `path` itself already sits directly under a component named
    // `apps` — cannot slip past by spelling.
    const escapes = imports.filter((name) => {
      if (!name.startsWith(".")) return false;
      const resolved = resolve(root, dirname(path), name).split(sep).join("/");
      const appsRoot = join(root, "apps").split(sep).join("/");
      return resolved === appsRoot || resolved.startsWith(`${appsRoot}/`);
    });
    if (escapes.length > 0) {
      violations.push({
        file: path,
        rule: "the installer package depends on nothing in apps/",
        detail: escapes.join(", "),
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
    const toolsAllowed = area === "tools" && !!toolsPackage && platform.every((name) => startsWithAny(name, toolsPackage.allowed));
    const installerAllowed =
      area === "installer" && platform.every((name) => startsWithAny(name, INSTALLER_ALLOWED));
    const allowed =
      PLATFORM_FILE.test(path) ||
      (area === "hub" && runtimeOnly) ||
      packageAllowed ||
      toolsAllowed ||
      installerAllowed;
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
