/**
 * One build attempt's directory, packaged: the gzip archive, the manifest
 * of every file it holds with its hash, and the deterministic checks on
 * both (`verify.ts`) — the archive re-hashed against the manifest, and
 * each named `web`/`api` target started and probed over HTTP.
 *
 * Lives here, below any agent runtime, because two callers need the same
 * bytes and the same checks: the host's build route
 * (`apps/hub/src/api-build.ts`), where the bounded build bridge keeps its
 * attempts, and the `publish_workspace` sidecar tool
 * (`@solutions-builder/tools-delivery`) kept for closures that ship it. A
 * host must not pull an agent runtime in to tar a directory, so nothing
 * here imports one.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { VerificationItem } from "./delivery.js";
import { hashFiles, shippedFiles, verifyArchive, type DeliveryVerificationContent, type ManifestFileEntry, type TargetProbe } from "./verify.js";

export type { ManifestFileEntry, TargetProbe } from "./verify.js";

export const BUNDLE_MEDIA_TYPE = "application/gzip";
export const MANIFEST_MEDIA_TYPE = "application/json";

/** The data-URI fallback's own, much lower ceiling: a base64 archive pasted
 *  into a mail reply breaks at the mail transport's ~44 MB cap and is
 *  fragile well before that (CL-8723 follow-up). */
export const FALLBACK_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

/** The manifest's own per-file list is capped so it stays small enough for a
 *  mail body a person and a model both read; the archive's real file count
 *  is reported separately so a truncated list is never mistaken for the
 *  whole picture. */
const MANIFEST_FILE_CAP = 200;

/**
 * Directories never worth shipping: reproducible, huge, generated, or not
 * part of the deliverable. `.corbits` is the worker's own: the turn hook
 * and the prompt packet the bridge places there for one attempt are the
 * host's plumbing, not the built software.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  "node_modules",
  ".git",
  ".corbits",
  ".venv",
  "__pycache__",
  "dist",
  ".cache",
  ".turbo",
  ".next",
  "coverage",
];

export type DeliveryManifestContent = {
  stage: 8;
  attempt: string;
  archive: { fileName: string; sizeBytes: number; sha256: string };
  files: ManifestFileEntry[];
  fileCount: number;
  truncated: boolean;
  generatedAt: string;
  /** What `verify.ts` established about this archive; absent only for a
   *  manifest written before #129. */
  verification?: DeliveryVerificationContent;
};

/** What the caller is told about the checks, beside the manifest's own record. */
export type VerificationSummary = {
  complete: boolean;
  /** Paths of required items that are not `verified`. */
  failed: string[];
  /** Every item not `verified`, required or not, in full: what was checked, its status and the tool's detail. */
  unverified: VerificationItem[];
  targets: { target: string; ranSuccessfully: boolean; transcript: string }[];
};

/** An attempt directory packaged, hashed and checked, with the bytes inline. */
export type PackagedAttempt = {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  dataUri: string;
  manifest: DeliveryManifestContent;
  verification: VerificationSummary;
};

/** A target named for probing is worth it only if it says how to start
 *  it and where it listens; anything less is dropped, not guessed at. A
 *  command given as one string runs through `sh -c`. */
export function parseTargetProbe(raw: unknown): TargetProbe | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const target = record["target"];
  const port = record["port"];
  const commandRaw = record["command"];
  const command = Array.isArray(commandRaw)
    ? commandRaw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : typeof commandRaw === "string" && commandRaw.trim().length > 0
      ? ["sh", "-c", commandRaw]
      : [];
  if (typeof target !== "string" || target.length === 0 || command.length === 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const routesRaw = record["routes"];
  const routes = Array.isArray(routesRaw) ? routesRaw.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/")) : [];
  const path = typeof record["path"] === "string" && (record["path"] as string).startsWith("/") ? (record["path"] as string) : undefined;
  return { target, command, port, routes, ...(path === undefined ? {} : { path }) };
}

/** Runs `tar` over the directory's shipped files (`shippedFiles`) and
 *  resolves with the gzip bytes. Shells out rather than reimplementing tar:
 *  every place this runs — a POSIX container image, or the host on macOS or
 *  Linux — has `tar` and `git` on PATH. */
export async function tarDirectory(cwd: string, exclude: readonly string[]): Promise<Buffer> {
  const files = await shippedFiles(cwd, new Set(exclude));
  return new Promise((res, reject) => {
    const child = spawn("tar", ["-czf", "-", "--null", "-T", "-"], { cwd });
    child.stdin.end(files.map((path) => `${path}\0`).join(""));
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited ${String(code)}: ${Buffer.concat(errChunks).toString("utf8")}`));
        return;
      }
      res(Buffer.concat(chunks));
    });
  });
}

/** Builds the delivery manifest by hashing every file the archive packed —
 *  read straight off disk, not the tar's own listing (which has no hashes),
 *  from the same `shippedFiles` list `tarDirectory` packs so the list
 *  matches what the archive contains. The file list is capped
 *  (`MANIFEST_FILE_CAP`); `fileCount` always reports the real total. */
export async function buildManifest(
  attempt: string,
  targetDir: string,
  exclude: readonly string[],
  archive: { fileName: string; sizeBytes: number; sha256: string },
): Promise<DeliveryManifestContent> {
  const hashed = await hashFiles(targetDir, await shippedFiles(targetDir, new Set(exclude)));
  const files = hashed.slice(0, MANIFEST_FILE_CAP);
  return {
    stage: 8,
    attempt,
    archive,
    files,
    fileCount: hashed.length,
    truncated: hashed.length > files.length,
    generatedAt: new Date().toISOString(),
  };
}

/** Runs the deterministic checks on the archive bytes and records them on
 *  the manifest, returning the summary. `manifestNodeId` names the archive
 *  the checks ran against: its artifact, or its hash when no artifact
 *  exists. `ranOn` says where the targets were started. */
export async function verifyAndRecord(
  manifest: DeliveryManifestContent,
  archiveBytes: Buffer,
  manifestNodeId: string,
  args: { exclude: readonly string[]; targets: readonly TargetProbe[] },
  targetDir: string,
  ranOn: "sidecar" | "host",
): Promise<VerificationSummary> {
  const verification = await verifyArchive({
    archiveBytes,
    manifest: manifest.files,
    manifestNodeId,
    probes: args.targets,
    cwd: targetDir,
    exclude: new Set(args.exclude),
    ranOn,
  });
  manifest.verification = verification;
  return {
    complete: verification.report.complete,
    failed: verification.report.failed,
    unverified: verification.items.filter((item) => item.status !== "verified"),
    targets: verification.targets.map((target) => ({ target: target.target, ranSuccessfully: target.ranSuccessfully, transcript: target.transcript })),
  };
}

/** The three heaviest top-level paths among the shipped files, sized. */
async function largestTopLevel(dir: string, exclude: readonly string[]): Promise<string> {
  const sizes = new Map<string, number>();
  for (const path of await shippedFiles(dir, new Set(exclude))) {
    const top = path.split("/")[0] ?? path;
    sizes.set(top, (sizes.get(top) ?? 0) + (await stat(join(dir, path))).size);
  }
  return [...sizes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([path, size]) => `${path} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    .join(", ");
}

/** Pulls the attempt number out of a `dir` like "attempts/3" for the
 *  artifact's `variant`/title; "1" when `dir` names no attempt (e.g. "."). */
export function attemptVariant(dir: string): string {
  const match = /(\d+)(?!.*\d)/.exec(dir);
  return `attempt-${match ? match[1] : "1"}`;
}

/**
 * Packages one attempt directory and runs the deterministic checks on the
 * archive. The archive comes back inline as a `data:` URI with its
 * manifest, which is the shape the client persists as the stage's
 * `build_evidence`.
 */
export async function packageAttempt(input: {
  /** The attempt directory, absolute. */
  dir: string;
  /** The attempt's variant, e.g. "attempt-3". */
  attempt: string;
  fileName?: string;
  exclude?: readonly string[];
  targets?: readonly TargetProbe[];
  /** Refused above this many archive bytes; the fallback's cap when unset. */
  maxBytes?: number;
  /** Where this runs, recorded on the manifest: the sidecar unless the host says otherwise. */
  ranOn?: "sidecar" | "host";
}): Promise<PackagedAttempt> {
  const fileName = input.fileName ?? "build.tar.gz";
  const exclude = [...new Set([...DEFAULT_EXCLUDES, ...(input.exclude ?? [])])];
  const targets = [...(input.targets ?? [])];
  const maxBytes = input.maxBytes ?? FALLBACK_MAX_ARCHIVE_BYTES;
  const bytes = await tarDirectory(input.dir, exclude);
  if (bytes.byteLength === 0) {
    throw new Error("publish_workspace: the tar produced no bytes — is the workspace empty?");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `publish_workspace: the archive is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit. ` +
        `Largest: ${await largestTopLevel(input.dir, exclude)}. Retry the attempt so the worker adds its build output to .gitignore.`,
    );
  }
  const dataUri = `data:${BUNDLE_MEDIA_TYPE};base64,${bytes.toString("base64")}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = await buildManifest(input.attempt, input.dir, exclude, { fileName, sizeBytes: bytes.byteLength, sha256 });
  const verification = await verifyAndRecord(manifest, bytes, `sha256:${sha256}`, { exclude, targets }, input.dir, input.ranOn ?? "sidecar");
  return { fileName, mediaType: BUNDLE_MEDIA_TYPE, sizeBytes: bytes.byteLength, sha256, dataUri, manifest, verification };
}
