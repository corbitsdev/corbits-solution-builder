/**
 * `publish_workspace` — tars the run's build workspace and uploads it as a
 * real, run-scoped artifact through `@corbits/artifacts`' binary create
 * route, so the archive survives past the run's release and shows up among
 * the project's artifacts the same way any other stage's draft does.
 *
 * This mirrors `@corbits/artifacts/sidecar-bundle`'s own resolve-and-call
 * shape (`requires: ["capabilities", "address"]`, resolve the `hub`
 * credential handle, call the run-scoped route through the mediated fetch)
 * rather than importing that package: this tool ships inside
 * `@solutions-builder/tools-delivery`, which every stage-8 AND stage-9
 * specialist carries unconditionally (`WORKFLOW_PACKAGE_DEPENDENCIES`).
 * Adding `@corbits/artifacts` as this package's own dependency would make it
 * a real install for every specialist, not just the credential-bound stage-8
 * one — the same class of mistake `ARTIFACT_TOOL_DEPENDENCIES` exists to
 * avoid (a specialist with no such dependency 404s the sidecar's tool-package
 * resolve). So the handful of lines this tool actually needs are duplicated
 * here instead.
 *
 * Alongside the archive, this also uploads a companion `delivery_manifest`
 * artifact: every packed file's path/sha256/size, plus the archive's own
 * sha256/size — the exact data stage 9's opening mail is built from
 * (`apps/web/src/pages/workspace/index.tsx`), since the delivery-verifier
 * has no filesystem and no view of stage 8's working directory.
 *
 * When the `hub` credential cannot be resolved (older, non-credential-bound
 * deploys, or a host that never wired the binding), this falls back to the
 * previous behavior: a `data:` URI in the tool result, with `fallback:
 * "data-uri"` in the JSON so the model and the client both know to treat it
 * as the old convention rather than a real artifact node. The fallback
 * enforces a much smaller size ceiling than the real upload path — a base64
 * `data:` URI pasted into a mail reply is fragile long before the mail
 * transport's own cap.
 */
import { defineTool, type BaseEnv } from "@intx/agent";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { BUILD_EVIDENCE_KIND, DELIVERY_MANIFEST_KIND } from "@solutions-builder/app/artifacts";

export const TOOL_NAME = "publish_workspace";

export const BUNDLE_MEDIA_TYPE = "application/gzip";
export const MANIFEST_MEDIA_TYPE = "application/json";

/** Mirrors `@corbits/artifacts`' `MAX_UPLOAD_BYTES` — the ceiling the hub's
 *  binary create route enforces on one uploaded file. Duplicated rather than
 *  imported (see module doc); a drift here only makes this tool's own
 *  pre-check looser or tighter than the hub's, never bypass it. */
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

/** The data-URI fallback's own, much lower ceiling: a base64 archive pasted
 *  into a mail reply breaks at the mail transport's ~44 MB cap and is
 *  fragile well before that (CL-8723 follow-up). */
const FALLBACK_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

/** The manifest's own per-file list is capped so it stays small enough for a
 *  mail body a person and a model both read; the archive's real file count
 *  is reported separately so a truncated list is never mistaken for the
 *  whole picture. */
const MANIFEST_FILE_CAP = 200;

/** Where a host mounts `mountWorkflowArtifacts`, and the credential handle a
 *  specialist's `credentialBindings` binds to it. Copied from
 *  `@corbits/artifacts/sidecar-bundle` for the same reason as
 *  `MAX_ARCHIVE_BYTES` above. */
const WORKFLOW_ARTIFACTS_BASE_PATH = "/api/workflow-artifacts";
const HUB_CREDENTIAL_HANDLE = "hub";

/** Directories never worth shipping: reproducible, huge, generated, or not part of the deliverable. */
const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  "dist",
  ".cache",
  ".turbo",
  ".next",
  "coverage",
];

/** Sidecar env this tool needs: the workspace directory the run's shell
 *  commands operate on (same key `@intx/tools-posix` declares), plus the
 *  capability registry and run address a credential-bound upload needs.
 *  `projectId` is NOT here — the host has no such env key. It reaches this
 *  tool as a constant closed over by `publishWorkspaceTool` below, rendered
 *  into the entry source at deploy time the same way `specialistEntrySource`
 *  already bakes in `SOURCE`. */
export interface PublishWorkspaceEnv extends BaseEnv {
  toolCwd: string;
  capabilities: RuntimeCapabilities;
  address: string;
}

type PublishWorkspaceArgs = {
  fileName: string;
  exclude: string[];
  dir: string;
};

export type ManifestFileEntry = { path: string; sha256: string; sizeBytes: number };

export type DeliveryManifestContent = {
  projectId: string;
  stage: 8;
  attempt: string;
  archive: { fileName: string; sizeBytes: number; sha256: string };
  files: ManifestFileEntry[];
  fileCount: number;
  truncated: boolean;
  generatedAt: string;
};

type UploadResult = {
  artifactId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  dir: string;
  manifest: { artifactId: string; version: number; fileCount: number; truncated: boolean };
};

type FallbackResult = {
  fallback: "data-uri";
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  dataUri: string;
};

/** Resolves `dir` (e.g. "attempts/3") against `cwd`, refusing anything that
 *  escapes it — the tool archives one attempt, never a sibling or a parent. */
function resolveDir(cwd: string, dirRaw: unknown): string {
  const dir = typeof dirRaw === "string" && dirRaw.length > 0 ? dirRaw : ".";
  if (isAbsolute(dir)) {
    throw new Error(`publish_workspace: "dir" must be relative to the working directory, got "${dir}"`);
  }
  const resolved = resolve(cwd, dir);
  const rel = relative(cwd, resolved);
  if (rel === ".." || rel.startsWith(`..${"/"}`)) {
    throw new Error(`publish_workspace: "dir" must stay inside the working directory, got "${dir}"`);
  }
  return resolved;
}

function parseArgs(args: Record<string, unknown>): PublishWorkspaceArgs {
  const fileNameRaw = args["fileName"];
  const fileName = typeof fileNameRaw === "string" && fileNameRaw.length > 0 ? fileNameRaw : "build.tar.gz";
  const excludeRaw = args["exclude"];
  const extra = Array.isArray(excludeRaw) ? excludeRaw.filter((entry): entry is string => typeof entry === "string") : [];
  const dirRaw = args["dir"];
  const dir = typeof dirRaw === "string" && dirRaw.length > 0 ? dirRaw : ".";
  return { fileName, exclude: [...new Set([...DEFAULT_EXCLUDES, ...extra])], dir };
}

/** Runs `tar` over the workspace directory and resolves with the gzip bytes.
 *  Shells out rather than reimplementing tar: every workspace this runs
 *  against is a POSIX container image with `tar` on PATH. */
function tarDirectory(cwd: string, exclude: string[]): Promise<Buffer> {
  return new Promise((res, reject) => {
    const args = ["-czf", "-", ...exclude.map((entry) => `--exclude=${entry}`), "."];
    const child = spawn("tar", args, { cwd });
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

/** Walks `dir` (relative paths from `dir` itself), skipping any path segment
 *  named in `exclude` — the same directories `tarDirectory` above excludes,
 *  so the manifest's file list matches what the archive actually contains. */
async function walkFiles(dir: string, exclude: ReadonlySet<string>, base: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(abs, exclude, base)));
    } else if (entry.isFile()) {
      results.push(relative(base, abs));
    }
  }
  return results;
}

/** Builds the delivery manifest by hashing every file the archive packed —
 *  read straight off disk, not the tar's own listing (which has no hashes).
 *  The file list is capped (`MANIFEST_FILE_CAP`); `fileCount` always reports
 *  the real total. */
async function buildManifest(
  projectId: string,
  attempt: string,
  targetDir: string,
  exclude: string[],
  archive: { fileName: string; sizeBytes: number; sha256: string },
): Promise<DeliveryManifestContent> {
  const paths = (await walkFiles(targetDir, new Set(exclude))).sort();
  const capped = paths.slice(0, MANIFEST_FILE_CAP);
  const files: ManifestFileEntry[] = await Promise.all(
    capped.map(async (path): Promise<ManifestFileEntry> => {
      const bytes = await readFile(join(targetDir, path));
      return { path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
    }),
  );
  return {
    projectId,
    stage: 8,
    attempt,
    archive,
    files,
    fileCount: paths.length,
    truncated: paths.length > files.length,
    generatedAt: new Date().toISOString(),
  };
}

/** Pulls the attempt number out of a `dir` like "attempts/3" for the
 *  artifact's `variant`/title; "1" when `dir` names no attempt (e.g. "."). */
function attemptVariant(dir: string): string {
  const match = /(\d+)(?!.*\d)/.exec(dir);
  return `attempt-${match ? match[1] : "1"}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

type MediatedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function resolveHubFetch(capabilities: RuntimeCapabilities): Promise<{ fetch: MediatedFetch; dispose(): void | Promise<void> } | undefined> {
  try {
    const credentials = capabilities.resolve("credentials");
    const credential = await credentials.resolve(HUB_CREDENTIAL_HANDLE);
    if (credential.kind !== "http") return undefined;
    return { fetch: (input, init) => credential.fetch(input, init), dispose: () => credential.dispose() };
  } catch (cause) {
    console.error(`publish_workspace: falling back to data-uri, could not resolve the "hub" credential: ${cause instanceof Error ? cause.message : String(cause)}`);
    return undefined;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
  }
  return `the hub answered ${String(response.status)}`;
}

async function uploadArtifact(
  fetchImpl: MediatedFetch,
  runAddress: string,
  args: { fileName: string; mimeType: string; bytes: Buffer; metadata: Record<string, unknown> },
): Promise<{ id: string; version: number }> {
  const response = await fetchImpl(`${WORKFLOW_ARTIFACTS_BASE_PATH}/artifacts/binary`, {
    method: "POST",
    headers: { "x-workflow-run-address": runAddress, "content-type": "application/json" },
    body: JSON.stringify({
      filename: args.fileName,
      mimeType: args.mimeType,
      contentBase64: args.bytes.toString("base64"),
      metadata: args.metadata,
    }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload: unknown = await response.json().catch(() => undefined);
  const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data: unknown }).data : payload;
  if (typeof data !== "object" || data === null || typeof (data as { id?: unknown }).id !== "string") {
    throw new Error("publish_workspace: the hub's binary create route returned no artifact id");
  }
  const version = (data as { version?: unknown }).version;
  return { id: (data as { id: string }).id, version: typeof version === "number" ? version : 1 };
}

async function publishWorkspaceContent(
  env: PublishWorkspaceEnv,
  projectId: string,
  rawArgs: Record<string, unknown>,
): Promise<UploadResult | FallbackResult> {
  const args = parseArgs(rawArgs);
  const targetDir = resolveDir(env.toolCwd, args.dir);
  const bytes = await tarDirectory(targetDir, args.exclude);
  if (bytes.byteLength === 0) {
    throw new Error("publish_workspace: the tar produced no bytes — is the workspace empty?");
  }

  const hub = await resolveHubFetch(env.capabilities);
  if (!hub) {
    if (bytes.byteLength > FALLBACK_MAX_ARCHIVE_BYTES) {
      throw new Error(
        `publish_workspace: the archive is ${bytes.byteLength} bytes, over the ${FALLBACK_MAX_ARCHIVE_BYTES}-byte fallback limit ` +
          `(no artifact-upload credential is available, so it would have to be pasted into a mail reply) — ` +
          `exclude node_modules/build output and retry.`,
      );
    }
    const dataUri = `data:${BUNDLE_MEDIA_TYPE};base64,${bytes.toString("base64")}`;
    return { fallback: "data-uri", fileName: args.fileName, mediaType: BUNDLE_MEDIA_TYPE, sizeBytes: bytes.byteLength, dataUri };
  }

  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `publish_workspace: the archive is ${bytes.byteLength} bytes, over the ${MAX_ARCHIVE_BYTES}-byte limit — ` +
        `exclude build outputs (e.g. compiled bundles, caches, lockfile-installed vendor trees) with "exclude" and try again.`,
    );
  }

  try {
    const variant = attemptVariant(args.dir);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const title = `${slugify(projectId)}-${variant}.tar.gz`;
    const created = await uploadArtifact(hub.fetch, env.address, {
      fileName: title,
      mimeType: BUNDLE_MEDIA_TYPE,
      bytes,
      metadata: {
        sb: {
          projectId,
          kind: BUILD_EVIDENCE_KIND,
          stage: 8,
          mediaType: BUNDLE_MEDIA_TYPE,
          variant,
          sourceVersionIds: [],
          provenance: { producer: "agent", agentRole: "build-engineer" },
        },
      },
    });

    const manifestContent = await buildManifest(projectId, variant, targetDir, args.exclude, {
      fileName: title,
      sizeBytes: bytes.byteLength,
      sha256,
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifestContent), "utf8");
    const manifestCreated = await uploadArtifact(hub.fetch, env.address, {
      fileName: `${slugify(projectId)}-${variant}-manifest.json`,
      mimeType: MANIFEST_MEDIA_TYPE,
      bytes: manifestBytes,
      metadata: {
        sb: {
          projectId,
          kind: DELIVERY_MANIFEST_KIND,
          stage: 8,
          mediaType: MANIFEST_MEDIA_TYPE,
          variant,
          sourceVersionIds: [created.id],
          provenance: { producer: "agent", agentRole: "build-engineer" },
        },
      },
    });

    return {
      artifactId: created.id,
      version: created.version,
      sha256,
      sizeBytes: bytes.byteLength,
      fileCount: manifestContent.fileCount,
      dir: args.dir,
      manifest: {
        artifactId: manifestCreated.id,
        version: manifestCreated.version,
        fileCount: manifestContent.fileCount,
        truncated: manifestContent.truncated,
      },
    };
  } finally {
    await hub.dispose();
  }
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    dir: {
      type: "string",
      description: 'The attempt directory to archive, relative to the working directory, e.g. "attempts/3". Defaults to the working directory itself.',
    },
    fileName: {
      type: "string",
      description: 'Archive file name, e.g. "my-project.tar.gz". Defaults to "build.tar.gz" in the data-URI fallback; ignored otherwise (the artifact title is derived from the project and attempt).',
    },
    exclude: {
      type: "array",
      items: { type: "string" },
      description: "Additional path patterns to exclude, beyond node_modules/.git/.venv/__pycache__/dist/.cache/.turbo/.next/coverage.",
    },
  },
} as const;

const DESCRIPTION =
  "Archives one directory of the run's build workspace (excluding node_modules/.git/dist/build caches) as a gzip tarball and uploads it as a real artifact the person can approve and keep, along with a delivery manifest (every packed file's path, sha256 and size). Falls back to returning a data: URI in the tool result, capped at 5 MB, when no artifact credential is bound.";

/**
 * Builds this tool bound to one project. `projectId` is a render-time
 * constant (see `specialist-source.ts`'s `specialistEntrySource`, which
 * writes `publishWorkspaceTool(${JSON.stringify(projectId)})` into the
 * generated entry source) — never something the model supplies.
 */
export function publishWorkspaceTool(projectId: string) {
  return defineTool<PublishWorkspaceEnv>({
    id: "@solutions-builder/tools-delivery/publish-workspace",
    requires: ["toolCwd", "capabilities", "address"],
    definitions: [{ name: TOOL_NAME, approval: "ask" as const }],
    factory: (env) => ({
      definitions: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA as unknown as Record<string, unknown> }],
      run: async (call, signal) => {
        try {
          signal.throwIfAborted();
          const result = await publishWorkspaceContent(env, projectId, call.arguments);
          return { callId: call.id, content: JSON.stringify(result) };
        } catch (err) {
          return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    }),
  });
}
