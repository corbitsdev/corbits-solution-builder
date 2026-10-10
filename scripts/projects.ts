/**
 * Projects from the command line: list them, export each as the bundle the
 * window's Export… writes, and import such bundles as new projects (#877).
 * For moving projects between installations that have no window open, over
 * ssh: export on one machine, copy the files, import on the other.
 *
 * Usage:
 *   bun scripts/projects.ts list [--json]
 *   bun scripts/projects.ts export --all [--archived] [--out <dir>]
 *   bun scripts/projects.ts export <projectId>... [--out <dir>]
 *   bun scripts/projects.ts import <file.json|file.zip>...
 *
 * Reaching the host, in order:
 *   --host <url> --token <token>, or SOLUTIONS_BUILDER_HOST_URL and
 *     SOLUTIONS_BUILDER_HOST_TOKEN: a host wherever it is, with its launch token.
 *   Otherwise the host running on this machine's data directory: the port it
 *     remembered in <data>/port and the token it keeps in the keychain.
 *   Otherwise one is started on that data directory for the run, and stopped
 *     after. --no-start refuses this. SOLUTIONS_BUILDER_DATA_DIR is honoured.
 *
 * The import always creates a new project, "<title> (imported)"; importing a
 * file twice gives two copies. The receiving workspace is installed first if
 * the window never has, and must have a model provider connected, since the
 * new project's workflow runs on one. Providers and credentials never
 * travel; the receiving instance connects its own.
 *
 * The owner session is the embedded hub's (`POST /api/owner/session`), so a
 * host whose hub is remote (SOLUTIONS_BUILDER_HUB_URL) is not reached here.
 */
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { dataDirectory } from "@corbits/embedded-host";
import { initSolutionsBuilderHost } from "../apps/hub/src/identity.js";
import { bundleFileName } from "../apps/web/src/project-export.ts";
import { jsonFromZip } from "../apps/web/src/project-import.ts";
import { attachHost, closureAndPush, hostAnswers, ownerTransport, startHost, type Host } from "./lib/owner-host.ts";
import { bundleOf, ensureWorkspace, exportProject, importBundle, listProjects, requireProvider, type ImportOutcome, type ProjectSummary } from "./lib/project-transfer.ts";

export type Command = "list" | "export" | "import";

export type Options = {
  readonly command: Command;
  readonly positional: readonly string[];
  readonly all: boolean;
  readonly archived: boolean;
  readonly json: boolean;
  readonly out: string;
  readonly host: string | null;
  readonly token: string | null;
  readonly start: boolean;
};

export class UsageError extends Error {}

const USAGE = `Usage:
  bun scripts/projects.ts list [--json]
  bun scripts/projects.ts export --all [--archived] [--out <dir>]
  bun scripts/projects.ts export <projectId>... [--out <dir>]
  bun scripts/projects.ts import <file.json|file.zip>...

Host: --host <url> --token <token> (or SOLUTIONS_BUILDER_HOST_URL / SOLUTIONS_BUILDER_HOST_TOKEN);
otherwise the host running on this machine's data directory, else one is started for the run (--no-start refuses).`;

/** The run `argv` asks for; throws `UsageError` naming what is wrong. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): Options {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "export" && command !== "import") {
    throw new UsageError(command ? `unknown command "${command}"` : "a command is required");
  }
  const positional: string[] = [];
  let all = false;
  let archived = false;
  let json = false;
  let out = ".";
  let host = env["SOLUTIONS_BUILDER_HOST_URL"]?.trim() || null;
  let token = env["SOLUTIONS_BUILDER_HOST_TOKEN"]?.trim() || null;
  let start = true;
  const valueOf = (flag: string, at: number): string => {
    const value = rest[at + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return value;
  };
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at]!;
    if (arg === "--all") all = true;
    else if (arg === "--archived") archived = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-start") start = false;
    else if (arg === "--out") out = valueOf(arg, at++);
    else if (arg === "--host") host = valueOf(arg, at++);
    else if (arg === "--token") token = valueOf(arg, at++);
    else if (arg.startsWith("--")) throw new UsageError(`unknown option "${arg}"`);
    else positional.push(arg);
  }
  if (command === "export" && all === (positional.length > 0)) throw new UsageError("export takes --all or one or more project ids, not both and not neither");
  if (command === "import" && positional.length === 0) throw new UsageError("import needs at least one bundle file");
  if (command === "list" && positional.length > 0) throw new UsageError("list takes no arguments");
  if ((host === null) !== (token === null)) throw new UsageError("--host and --token go together");
  return { command, positional, all, archived, json, out, host: host?.replace(/\/+$/, "") ?? null, token, start };
}

/** The file a bundle is written to under `dir`, never over another written this run. */
export function uniqueBundlePath(dir: string, title: string, projectId: string, taken: Set<string>): string {
  const name = bundleFileName(title);
  let candidate = join(dir, name);
  if (taken.has(candidate)) candidate = join(dir, name.replace(/\.solutions-builder\.json$/, `-${projectId.slice(-6)}.solutions-builder.json`));
  taken.add(candidate);
  return candidate;
}

async function connect(options: Options): Promise<Host> {
  if (options.host && options.token) {
    if (!(await hostAnswers(options.host, options.token))) throw new Error(`no host answers at ${options.host} for that token`);
    return { origin: options.host, token: options.token, stop: async () => undefined };
  }
  const attached = await attachHost();
  if (attached) return attached;
  const dataDir = dataDirectory();
  if (!options.start) throw new Error(`no host is running on ${dataDir}, and --no-start was given`);
  console.error(`No host is running on ${dataDir}; starting one for this run…`);
  return startHost(dataDir);
}

function describe(summary: ProjectSummary): string {
  return `${summary.id}  ${summary.title}${summary.archivedAt ? "  (archived)" : ""}`;
}

async function runList(host: Host, options: Options): Promise<number> {
  const { transport } = ownerTransport(host);
  await transport.fetch("POST", "/api/owner/session");
  const projects = await listProjects(transport);
  if (options.json) {
    console.log(JSON.stringify(projects.map(({ id, title, archivedAt, createdAt }) => ({ id, title, archivedAt, createdAt })), null, 2));
  } else {
    for (const project of projects) console.log(describe(project));
    if (projects.length === 0) console.log("No projects.");
  }
  return 0;
}

async function runExport(host: Host, options: Options): Promise<number> {
  const session = ownerTransport(host);
  await session.transport.fetch("POST", "/api/owner/session");
  const listed = await listProjects(session.transport);
  const chosen = options.all
    ? listed.filter((project) => options.archived || project.archivedAt === null)
    : options.positional.map((id) => {
        const found = listed.find((project) => project.id === id);
        if (!found) throw new Error(`no project ${id}`);
        return found;
      });
  const dir = resolve(options.out);
  await mkdir(dir, { recursive: true });
  const taken = new Set<string>();
  let failed = 0;
  for (const project of chosen) {
    const path = uniqueBundlePath(dir, project.title, project.id, taken);
    try {
      const bundle = await exportProject(session, project.id);
      await Bun.write(path, JSON.stringify(bundle, null, 2));
      const messages = bundle.conversations.reduce((total, thread) => total + thread.messages.length, 0);
      console.log(`${project.title}: ${String(bundle.artifacts.length)} artifact(s), ${String(messages)} message(s) -> ${path}`);
    } catch (cause) {
      failed += 1;
      console.error(`${project.title}: not exported: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  console.log(`Exported ${String(chosen.length - failed)} of ${String(chosen.length)} project(s) to ${dir}`);
  return failed === 0 ? 0 : 1;
}

async function readBundleFile(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (path.toLowerCase().endsWith(".zip")) return jsonFromZip(new Uint8Array(await file.arrayBuffer()), basename(path));
  return JSON.parse(await file.text());
}

async function runImport(host: Host, options: Options): Promise<number> {
  const session = ownerTransport(host);
  await session.transport.fetch("POST", "/api/owner/session");
  const workspace = await ensureWorkspace(session.transport);
  await requireProvider(session.transport, workspace);
  const status = await session.transport.fetch<{ canPlaceSidecars?: boolean }>("GET", "/api/status");
  const sidecar = { canPlaceSidecars: status.canPlaceSidecars === true };
  const { closure, gitPush } = await closureAndPush(host, session.cookie, "scripts/projects.ts");
  const outcomes: { path: string; outcome: ImportOutcome | null; failure: string | null }[] = [];
  for (const given of options.positional) {
    const path = resolve(given);
    try {
      const bundle = bundleOf(await readBundleFile(path));
      console.log(`${basename(path)}: importing "${bundle.project.title}"…`);
      const outcome = await importBundle(bundle, { session, workspace, sidecar, closure, gitPush, onProgress: (line) => console.error(line) });
      outcomes.push({ path, outcome, failure: null });
    } catch (cause) {
      outcomes.push({ path, outcome: null, failure: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  console.log("\nImport report:");
  let failed = 0;
  for (const { path, outcome, failure } of outcomes) {
    if (!outcome) {
      failed += 1;
      console.log(`FAIL  ${basename(path)}: ${failure ?? "not imported"}`);
      continue;
    }
    const landing = outcome.landed === null ? "nothing to replay" : `at stage ${String(outcome.landed)}`;
    const ok = outcome.stopped === null;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${basename(path)}: ${outcome.title} (${outcome.projectId}): ${String(outcome.artifacts)} artifact(s), ${String(outcome.versions)} version(s), ${String(outcome.conversations)} conversation(s); ${landing}${outcome.stopped ? ` - ${outcome.stopped}` : ""}`);
    for (const note of outcome.notes) console.log(`      ${note}`);
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (cause) {
    console.error(cause instanceof UsageError ? `${cause.message}\n\n${USAGE}` : String(cause));
    process.exit(2);
  }
  initSolutionsBuilderHost();
  const host = await connect(options);
  let code = 1;
  try {
    code = await (options.command === "list" ? runList(host, options) : options.command === "export" ? runExport(host, options) : runImport(host, options));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
  } finally {
    await host.stop();
  }
  process.exit(code);
}
