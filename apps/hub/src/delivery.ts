/**
 * Delivery verification — the bytes behind a manifest are checked, not
 * trusted. Each check is recorded as an artifact version of kind
 * `delivery_verification` whose source is the manifest version it checked, so
 * "what was verified, against what, when" is a version like every other
 * record here.
 *
 * Existence checks (below) only prove a descriptor's bytes are present; they
 * cannot tell working software from a scaffold of stubs. `runExecutionChecks`
 * closes that gap by actually running the deliverable's entry point, and its
 * declared tests and typecheck, inside the workspace. This is deliberately
 * narrow, not a sandbox (that is CL-7956's job):
 *   - one bounded child process per check, cwd pinned to the workspace,
 *     stdin closed so nothing can block waiting for input;
 *   - a hard wall-clock timeout per check, escalating from SIGTERM to
 *     SIGKILL, so a hang cannot stall verification forever;
 *   - stdout/stderr are drained to a bounded tail as they arrive, never
 *     buffered in full, so a runaway writer cannot exhaust memory;
 *   - the environment is trimmed to PATH plus a scratch HOME made fresh for
 *     the run and discarded after it, not the host process's full env or its
 *     real home directory — so generated code cannot reach the operator's
 *     `~/.ssh`, `~/.aws`, `~/.npmrc`, or git credential helpers.
 * What it does NOT do: no filesystem, network, or process-namespace
 * isolation. A deliverable can still read/write outside the workspace, reach
 * the network, or leave grandchild processes running after its own process
 * is killed — none of that is contained here.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
  DeliveryManifest,
  describeBlockers,
  summarizeVerification,
  type DeliveryDescriptor,
  type VerificationItem,
  type VerificationReport,
} from "@solutions-builder/app/delivery";
import { type } from "arktype";
import { database } from "./db.js";
import * as table from "./schema.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import { workspaceFor } from "./corbits-exec.js";

const ENTRY_POINT_TIMEOUT_MS = 15_000;
const SCRIPT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_TAIL_BYTES = 4_000;

/** Conventional CLI entry points tried when `package.json` names none. */
const ENTRY_POINT_CANDIDATES = ["src/cli.ts", "src/index.ts", "src/main.ts", "index.ts", "main.ts", "bin/cli.ts"];

type PackageManifest = { scripts?: Record<string, string>; main?: string };

export type ExecutionKind = "entry_point" | "test" | "typecheck";

/** What ran, how it was bounded, and what it produced — never just an exit code. */
export type ExecutionCheck = {
  readonly kind: ExecutionKind;
  readonly command: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Whether this check counts as passing. False blocks delivery like a required descriptor would. */
  readonly ok: boolean;
  readonly detail: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
};

/** A `VerificationReport` plus what actually ran, so "present" and "works" are distinct. */
export type DeliveryVerificationReport = VerificationReport & {
  readonly execution: ExecutionCheck[];
};

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const info = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return { sha256: hash.digest("hex"), sizeBytes: info.size };
}

/** Keeps a descriptor's path inside the workspace it claims to describe. */
function containedPath(root: string, relative: string): string | null {
  if (isAbsolute(relative)) return null;
  const resolved = normalize(join(root, relative));
  return resolved.startsWith(normalize(root) + "/") ? resolved : null;
}

async function checkDescriptor(descriptor: DeliveryDescriptor, workspaceRoot: string): Promise<VerificationItem> {
  const base = { category: descriptor.category, path: descriptor.path, required: descriptor.required };
  // No remote fetcher exists in this host. A remote descriptor is unverified
  // until one does; a local file of the same name proves nothing about it.
  if (descriptor.access === "remote") {
    return { ...base, status: "inaccessible", detail: "no remote fetcher is configured on this host" };
  }
  const path = containedPath(workspaceRoot, descriptor.path);
  if (!path) return { ...base, status: "inaccessible", detail: "the path leaves the build workspace" };
  try {
    const actual = await hashFile(path);
    if (actual.sha256 !== descriptor.sha256 || actual.sizeBytes !== descriptor.sizeBytes) {
      return {
        ...base,
        status: "hash_mismatch",
        detail: `expected ${descriptor.sha256.slice(0, 12)} (${descriptor.sizeBytes} bytes), found ${actual.sha256.slice(0, 12)} (${actual.sizeBytes} bytes)`,
      };
    }
    return { ...base, status: "verified" };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ...base, status: "missing" };
    return { ...base, status: "inaccessible", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Reads a pipe to a bounded tail: the last `maxBytes`, never the whole stream. */
async function drainTail(pipe: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!pipe) return "";
  const decoder = new TextDecoder();
  const reader = pipe.getReader();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = (tail + decoder.decode(value, { stream: true })).slice(-maxBytes);
  }
  return tail;
}

/** Runs one command to completion or to its timeout, whichever comes first. */
async function execBounded(
  command: string[],
  cwd: string,
  timeoutMs: number,
  home: string,
): Promise<{ exitCode: number | null; timedOut: boolean; stdoutTail: string; stderrTail: string }> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Not the host's own env, and not the host's own home directory either:
    // `HOME` is where credentials live (`~/.ssh`, `~/.aws`, `~/.npmrc`, git
    // credential helpers), so generated code gets PATH to find tools plus a
    // scratch HOME made fresh for this run, nothing it could read as a
    // credential or exfiltrate.
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, timeoutMs);
  const [stdoutTail, stderrTail] = await Promise.all([
    drainTail(child.stdout, OUTPUT_TAIL_BYTES),
    drainTail(child.stderr, OUTPUT_TAIL_BYTES),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  return { exitCode: timedOut ? null : exitCode, timedOut, stdoutTail, stderrTail };
}

/** The command to run the deliverable itself, or null when none is discoverable. */
async function discoverEntryPoint(workspaceRoot: string, pkg: PackageManifest | null): Promise<string[] | null> {
  // `--silent` matters here: without it `bun run <script>` echoes "$ <command>"
  // to stdout, which would read as output the deliverable itself never wrote.
  if (pkg?.scripts?.start) return ["bun", "run", "--silent", "start"];
  if (typeof pkg?.main === "string" && containedPath(workspaceRoot, pkg.main)) return ["bun", "run", pkg.main];
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    const resolved = containedPath(workspaceRoot, candidate);
    if (resolved && (await Bun.file(resolved).exists())) return ["bun", "run", candidate];
  }
  return null;
}

async function runEntryPoint(command: string[], workspaceRoot: string, home: string): Promise<ExecutionCheck> {
  const raw = await execBounded(command, workspaceRoot, ENTRY_POINT_TIMEOUT_MS, home);
  const producedOutput = raw.stdoutTail.trim().length > 0 || raw.stderrTail.trim().length > 0;
  const ok = !raw.timedOut && raw.exitCode === 0 && producedOutput;
  const detail = raw.timedOut
    ? `entry point exceeded ${ENTRY_POINT_TIMEOUT_MS}ms and was killed`
    : raw.exitCode !== 0
      ? `entry point exited ${raw.exitCode}`
      : !producedOutput
        ? "entry point exited 0 but produced no output on stdout or stderr"
        : "entry point ran and produced output";
  return { kind: "entry_point", command: command.join(" "), exitCode: raw.exitCode, timedOut: raw.timedOut, ok, detail, stdoutTail: raw.stdoutTail, stderrTail: raw.stderrTail };
}

async function runDeclaredScript(kind: "test" | "typecheck", workspaceRoot: string, home: string): Promise<ExecutionCheck> {
  const command = ["bun", "run", "--silent", kind];
  const raw = await execBounded(command, workspaceRoot, SCRIPT_TIMEOUT_MS, home);
  // `bun test` exits 1 when it finds zero test files under the deliverable —
  // the same exit code a genuinely failing suite produces. Seeding always
  // declares a `test` script, so a deliverable nobody wrote tests for would
  // otherwise be blocked from delivery by accident, indistinguishable from
  // one whose tests actually fail. This is a deliberate call: "no tests
  // exist yet" is read from bun's own message and treated as passing, not
  // as a failure this check is in a position to force — whether a
  // deliverable needs tests is a decision for delivery review, not this
  // process's exit code.
  const noTestFiles =
    kind === "test" && !raw.timedOut && /No tests found!|0 test files matching/.test(raw.stderrTail);
  const ok = !raw.timedOut && (raw.exitCode === 0 || noTestFiles);
  const detail = raw.timedOut
    ? `${kind} exceeded ${SCRIPT_TIMEOUT_MS}ms and was killed`
    : noTestFiles
      ? "no test files were found; not treated as a failure"
      : ok
        ? `${kind} passed`
        : `${kind} exited ${raw.exitCode}`;
  return { kind, command: command.join(" "), exitCode: raw.exitCode, timedOut: raw.timedOut, ok, detail, stdoutTail: raw.stdoutTail, stderrTail: raw.stderrTail };
}

/**
 * Runs the deliverable's own entry point, and its declared tests and
 * typecheck, inside `workspaceRoot`. Nothing here is presence checking —
 * every item is a process that actually ran, or an explicit record that it
 * did not.
 */
async function runExecutionChecks(workspaceRoot: string): Promise<ExecutionCheck[]> {
  const pkgPath = join(workspaceRoot, "package.json");
  const pkg: PackageManifest | null = (await Bun.file(pkgPath).exists())
    ? (JSON.parse(await Bun.file(pkgPath).text()) as PackageManifest)
    : null;

  // One scratch HOME for every check in this run, made fresh and discarded
  // after — never the host's real home directory (see the file header).
  const home = await mkdtemp(join(tmpdir(), "solutions-builder-deliverable-home-"));
  try {
    const checks: ExecutionCheck[] = [];
    const entry = await discoverEntryPoint(workspaceRoot, pkg);
    if (entry) checks.push(await runEntryPoint(entry, workspaceRoot, home));
    for (const kind of ["test", "typecheck"] as const) {
      if (pkg?.scripts?.[kind]) checks.push(await runDeclaredScript(kind, workspaceRoot, home));
    }
    return checks;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Checks every descriptor against the bytes under `workspaceRoot`, then runs
 * the deliverable to see whether it does anything. A required descriptor
 * that is merely present no longer reads as "verified" on its own — an
 * execution check that fails is exactly as blocking.
 */
export async function verifyManifest(
  manifestNodeId: string,
  manifest: DeliveryManifest,
  workspaceRoot: string,
): Promise<DeliveryVerificationReport> {
  const items: VerificationItem[] = [];
  for (const descriptor of manifest.descriptors) items.push(await checkDescriptor(descriptor, workspaceRoot));
  const base = summarizeVerification(manifestNodeId, items, new Date());
  const execution = await runExecutionChecks(workspaceRoot);
  const executionFailures = execution.filter((check) => !check.ok).map((check) => `execution:${check.kind}`);
  return {
    ...base,
    complete: base.complete && executionFailures.length === 0,
    failed: [...base.failed, ...executionFailures],
    execution,
  };
}

export type ManifestVersion = {
  node: typeof table.artifactNode.$inferSelect;
  manifest: DeliveryManifest;
};

/** The newest delivery manifest on a project, parsed, or null before stage 9. */
export async function latestManifest(projectId: string): Promise<ManifestVersion | null> {
  const { db } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(and(eq(table.artifactNode.projectId, projectId), eq(table.artifactNode.kind, "delivery_manifest")))
    .orderBy(desc(table.artifactNode.createdAt))
    .limit(1);
  if (!node) return null;
  const { content } = await readArtifactNode(node.id);
  const parsed = DeliveryManifest(JSON.parse(content));
  if (parsed instanceof type.errors) {
    throw new Error(`Delivery manifest ${node.id} does not parse: ${parsed.summary}`);
  }
  return { node, manifest: parsed };
}

/** The newest verification recorded for a manifest version, or null. */
export async function latestVerification(manifestNodeId: string): Promise<DeliveryVerificationReport | null> {
  const { db } = database();
  const rows = await db
    .select({ childNodeId: table.artifactEdge.childNodeId })
    .from(table.artifactEdge)
    .where(eq(table.artifactEdge.sourceNodeId, manifestNodeId));
  let newest: { report: DeliveryVerificationReport; createdAt: Date } | null = null;
  for (const row of rows) {
    const { node, content } = await readArtifactNode(row.childNodeId);
    if (node.kind !== "delivery_verification") continue;
    if (newest && newest.createdAt > node.createdAt) continue;
    newest = { report: JSON.parse(content) as DeliveryVerificationReport, createdAt: node.createdAt };
  }
  return newest?.report ?? null;
}

/**
 * Verifies the manifest's bytes in the build workspace that produced it and
 * records the report as a version sourced from the manifest.
 */
export async function verifyAndRecord(
  projectId: string,
  version: ManifestVersion,
  actor: { principalId: string },
): Promise<DeliveryVerificationReport> {
  // The manifest's producer run is the build run whose workspace holds the bytes.
  const buildRunId = version.node.producerRunId ?? "";
  const workspaceRoot = await workspaceFor(buildRunId);
  const report = await verifyManifest(version.node.id, version.manifest, workspaceRoot);
  await writeArtifact(
    {
      projectId,
      kind: "delivery_verification",
      title: report.complete ? "Delivery verified" : "Delivery verification failed",
      content: JSON.stringify(report, null, 2),
      mediaType: "application/json",
      sourceVersionIds: [version.node.id],
      provenance: { producer: "human", ...(buildRunId ? { runId: buildRunId } : {}) },
    },
    actor,
  );
  return report;
}

/** One sentence naming what execution checks failed, or null when all passed. */
function describeExecutionFailures(execution: ExecutionCheck[]): string | null {
  const failed = execution.filter((check) => !check.ok);
  if (failed.length === 0) return null;
  return `execution failed: ${failed.map((check) => `${check.kind} (${check.detail})`).join("; ")}`;
}

/** What blocks acceptance of the project's latest manifest, or null when nothing does. */
export async function deliveryBlockers(projectId: string): Promise<string | null> {
  const version = await latestManifest(projectId);
  if (!version) return null;
  const report = await latestVerification(version.node.id);
  if (!report) return "Delivery cannot be accepted yet. The manifest has not been verified.";
  const existence = describeBlockers(report);
  const execution = describeExecutionFailures(report.execution);
  if (!existence && !execution) return null;
  if (existence && execution) return `${existence} ${execution}.`;
  return existence ?? `Delivery cannot be accepted yet. ${execution}.`;
}
