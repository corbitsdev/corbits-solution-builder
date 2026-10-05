/**
 * The deterministic delivery checks (#129), run where the files are: on
 * the host, by the build route's packaging of an attempt
 * (`package-attempt.ts`), or in a sidecar by `publish_workspace`. Nothing
 * here takes a model's word for anything.
 *
 * Two checks, both recorded as `VerificationItem`s with `checkedBy: "tool"`:
 *
 * - The archive's contents against the manifest. The gzip bytes that will be
 *   uploaded are extracted again into a scratch directory and every file
 *   there is hashed; each manifest entry is `verified` when the archive
 *   holds the same bytes, `hash_mismatch` when it holds different ones, and
 *   `missing` when it holds none. So the manifest stage 9 reads describes
 *   the archive it is handed, not the directory the archive was made from.
 * - Each `web`/`api` target named for probing, started with the command
 *   and port given and probed over HTTP by `target-verify.ts`. The port opening and the
 *   responses that come back are what is recorded; a target whose port
 *   never opens is `failed`. A `cli`, `desktop` or other target has no
 *   verifier in this repo and is `inaccessible`, never assumed.
 *
 * What is NOT checked is said as plainly: files past the manifest's cap are
 * not listed and not claimed, and a web probe is an HTTP response check with
 * no browser (its transcript says so).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { summarizeVerification, type VerificationItem, type VerificationReport } from "./delivery.js";
import { verifyApiTarget, verifyWebTarget } from "./target-verify.js";
import { classifyTarget, type TargetVerification } from "./targets.js";

export type ManifestFileEntry = { path: string; sha256: string; sizeBytes: number };

/** A target to exercise: what it is, how it starts, and where it listens.
 *  The tool runs it; whoever names it — a person, a model — only names it. */
export type TargetProbe = {
  target: string;
  /** The start command, run with the attempt directory as its cwd. */
  command: readonly string[];
  port: number;
  /** `api` only: the routes to GET once the port is open. */
  routes: readonly string[];
  /** `web` only: the page to fetch; `/` when unset. */
  path?: string;
  /** How long to wait for the port; the verifier's default when unset. Tests shorten it. */
  startTimeoutMs?: number;
};

/** What `publish_workspace` records beside the manifest's file list. */
export type DeliveryVerificationContent = {
  checkedAt: string;
  checkedBy: "tool";
  /** Where the targets were started and probed: in a specialist's sidecar,
   *  or on the host itself, where the bounded build bridge keeps its
   *  attempts and a person's own start command runs. Absent on a manifest
   *  written before this was recorded (a sidecar run). */
  ranOn?: "sidecar" | "host";
  /** Files in the archive the manifest does not list (past its cap, or not
   *  on disk when the manifest was built). Counted, never claimed. */
  archiveExtras: number;
  items: VerificationItem[];
  targets: TargetVerification[];
  report: VerificationReport;
};

/** Walks `dir` and returns every regular file's path (relative, POSIX) with
 *  its sha256 and size, skipping any path segment named in `exclude`. */
export async function hashTree(dir: string, exclude: ReadonlySet<string>): Promise<ManifestFileEntry[]> {
  return hashFiles(dir, await walkFiles(dir, exclude));
}

/** Every regular file under `dir` that ships, sorted: what git leaves
 *  unignored, judged only by the directory's own `.gitignore` files and
 *  `exclude` (gitignore patterns). Listed through a throwaway repository, so
 *  neither an enclosing one nor the host's global excludes decide. An empty
 *  list is refused: an archive of nothing is not a build. */
export async function shippedFiles(dir: string, exclude: readonly string[]): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "sb-ship-"));
  let listed: string;
  try {
    await runGit(["init", "-q", "--bare", "--template=", scratch]);
    listed = await runGit([
      "-c",
      "core.excludesFile=",
      `--git-dir=${scratch}`,
      `--work-tree=${dir}`,
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      ...exclude.map((pattern) => `--exclude=${pattern}`),
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const paths = listed.split("\0").filter((path) => path.length > 0);
  const stats = await Promise.all(paths.map((path) => lstat(join(dir, path))));
  const files = paths.filter((_, at) => stats[at]!.isFile()).sort();
  if (files.length === 0) throw new Error(`There is nothing to package in ${dir}: every file is excluded or ignored by a .gitignore.`);
  return files;
}

function runGit(args: readonly string[]): Promise<string> {
  return new Promise((res, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) res(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`git ${args.join(" ")} exited ${String(code)}: ${Buffer.concat(err).toString("utf8")}`));
    });
  });
}

/** Hashes each listed file (relative, POSIX) under `dir`, in path order. */
export async function hashFiles(dir: string, paths: readonly string[]): Promise<ManifestFileEntry[]> {
  return Promise.all(
    [...paths].sort().map(async (path): Promise<ManifestFileEntry> => {
      const bytes = await readFile(join(dir, path));
      return { path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
    }),
  );
}

async function walkFiles(dir: string, exclude: ReadonlySet<string>, base: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(abs, exclude, base)));
    } else if (entry.isFile()) {
      results.push(relative(base, abs).split("\\").join("/"));
    }
  }
  return results;
}

/** Extracts gzip tar bytes into a fresh scratch directory and returns it;
 *  the caller removes it. Shells out to `tar` the way the archive was made. */
export async function extractArchive(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sb-verify-"));
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", "-", "-C", dir]);
    const errChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`tar -x exited ${String(code)}: ${Buffer.concat(errChunks).toString("utf8")}`));
      else resolve();
    });
    child.stdin.end(bytes);
  });
  return dir;
}

/**
 * One item per manifest entry, scored only from what the archive holds.
 * Pure: hand it the manifest's list and the extracted tree's hashes.
 */
export function compareArchiveToManifest(
  manifest: readonly ManifestFileEntry[],
  archive: readonly ManifestFileEntry[],
): { items: VerificationItem[]; extras: number } {
  const inArchive = new Map(archive.map((entry) => [entry.path, entry]));
  const items: VerificationItem[] = manifest.map((expected) => {
    const found = inArchive.get(expected.path);
    if (!found) {
      return { category: "source", path: expected.path, required: true, status: "missing", checkedBy: "tool", detail: "not in the archive" };
    }
    if (found.sha256 !== expected.sha256) {
      return {
        category: "source",
        path: expected.path,
        required: true,
        status: "hash_mismatch",
        checkedBy: "tool",
        detail: `archive holds sha256 ${found.sha256.slice(0, 12)}…, manifest says ${expected.sha256.slice(0, 12)}…`,
      };
    }
    return { category: "source", path: expected.path, required: true, status: "verified", checkedBy: "tool" };
  });
  const listed = new Set(manifest.map((entry) => entry.path));
  const extras = archive.filter((entry) => !listed.has(entry.path)).length;
  return { items, extras };
}

/** The one line of a probe's transcript a checklist row can carry. */
function summarizeTranscript(verification: TargetVerification): string {
  const lines = verification.transcript.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("$ "));
  return lines.slice(0, 3).join(" · ");
}

/** Runs each named target and turns the outcome into an item. */
export async function probeTargets(probes: readonly TargetProbe[], cwd: string): Promise<{ items: VerificationItem[]; targets: TargetVerification[] }> {
  const items: VerificationItem[] = [];
  const targets: TargetVerification[] = [];
  for (const probe of probes) {
    const modality = classifyTarget(probe.target);
    const path = `target:${probe.target}`;
    if (modality !== "web" && modality !== "api") {
      const transcript = `no ${modality} verifier exists in this repo; "${probe.target}" was not exercised.`;
      targets.push({ target: probe.target, modality, exercised: false, realInputFed: false, ranSuccessfully: false, producedOutput: false, transcript });
      items.push({ category: "receipts", path, required: true, status: "inaccessible", checkedBy: "tool", detail: transcript });
      continue;
    }
    const base = { command: probe.command, cwd, port: probe.port, ...(probe.startTimeoutMs === undefined ? {} : { startTimeoutMs: probe.startTimeoutMs }) };
    const verification =
      modality === "web"
        ? await verifyWebTarget(probe.target, { ...base, ...(probe.path === undefined ? {} : { path: probe.path }) })
        : await verifyApiTarget(probe.target, { ...base, routes: probe.routes });
    targets.push(verification);
    items.push({
      category: "receipts",
      path,
      required: true,
      status: verification.ranSuccessfully ? "verified" : verification.exercised ? "failed" : "inaccessible",
      checkedBy: "tool",
      detail: summarizeTranscript(verification),
    });
  }
  return { items, targets };
}

/**
 * The whole verification for one archive: its contents against `manifest`,
 * plus every target probe, summarized into the report stage 9 reads.
 */
export async function verifyArchive(input: {
  archiveBytes: Uint8Array;
  manifest: readonly ManifestFileEntry[];
  manifestNodeId: string;
  probes: readonly TargetProbe[];
  /** Where the targets start: the attempt directory. */
  cwd: string;
  exclude: ReadonlySet<string>;
  ranOn: "sidecar" | "host";
  /** The one folder the archive unpacks into (#699); the manifest's paths are relative to it. */
  root?: string;
}): Promise<DeliveryVerificationContent> {
  const extracted = await extractArchive(input.archiveBytes);
  let compared: { items: VerificationItem[]; extras: number };
  try {
    compared = compareArchiveToManifest(input.manifest, await hashTree(input.root ? join(extracted, input.root) : extracted, input.exclude));
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
  const probed = await probeTargets(input.probes, input.cwd);
  const items = [...compared.items, ...probed.items];
  const checkedAt = new Date();
  return {
    checkedAt: checkedAt.toISOString(),
    checkedBy: "tool",
    ranOn: input.ranOn,
    archiveExtras: compared.extras,
    items,
    targets: probed.targets,
    report: summarizeVerification(input.manifestNodeId, items, checkedAt),
  };
}
