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
 * specialist carries (`DELIVERY_TOOL_DEPENDENCIES`).
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
 * The manifest also carries `verification` (#129): the deterministic checks
 * `verify.ts` runs here, where the files are — the archive's own contents
 * re-hashed against the manifest, and each `web`/`api` target the build
 * engineer names started and probed over HTTP. Stage 9 reads those results;
 * it scores nothing itself, and nothing a model says becomes a pass.
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
import { readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { BUILD_EVIDENCE_KIND, DELIVERY_MANIFEST_KIND } from "@solutions-builder/specialist-runtime/artifact-kinds";
import { hashTree, verifyArchive, type DeliveryVerificationContent, type ManifestFileEntry, type TargetProbe } from "./verify.js";

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
 *  No project id: the run's own tenant is the project (#29), and the hub's
 *  run-scoped mount labels what this uploads from that scope
 *  (`embed-hub/src/workflow-artifact-label.ts`). */
export interface PublishWorkspaceEnv extends BaseEnv {
  toolCwd: string;
  capabilities: RuntimeCapabilities;
  address: string;
}

type PublishWorkspaceArgs = {
  fileName: string;
  exclude: string[];
  /** null when the model named no directory: the tool picks the attempt. */
  dir: string | null;
  /** The targets to start and probe; none when the model named none. */
  targets: TargetProbe[];
};

export type { ManifestFileEntry, TargetProbe } from "./verify.js";

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

/** What the model is told about the checks, in both result shapes. */
export type VerificationSummary = {
  complete: boolean;
  /** Paths of required items that are not `verified`. */
  failed: string[];
  targets: { target: string; ranSuccessfully: boolean; transcript: string }[];
};

type UploadResult = {
  artifactId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  dir: string;
  manifest: { artifactId: string; version: number; fileCount: number; truncated: boolean };
  verification: VerificationSummary;
};

type FallbackResult = {
  fallback: "data-uri";
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  dataUri: string;
  /** The manifest, with its verification, inline: with no upload credential
   *  there is no artifact to hold it, so the client persists it beside the
   *  archive the same way it persists the archive itself. */
  manifest: DeliveryManifestContent;
  verification: VerificationSummary;
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

/** The model supplies nothing this tool cannot work out for itself, so any
 *  shape is accepted -- an empty object, a bare string, a malformed blob.
 *  A small model that calls the tool at all should not be able to fail here. */
/** The attempt the build is on, worked out from the workspace rather than
 *  asked of the model: the highest-numbered `attempts/<n>` directory, or the
 *  working directory itself when the build never made one. */
async function currentAttemptDir(cwd: string): Promise<string> {
  try {
    const entries = await readdir(join(cwd, "attempts"), { withFileTypes: true });
    const numbered = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => b - a);
    return numbered.length > 0 ? join("attempts", String(numbered[0])) : ".";
  } catch {
    return ".";
  }
}

/** A target the model names is worth probing only if it says how to start
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

function parseArgs(raw: unknown): PublishWorkspaceArgs {
  const args: Record<string, unknown> = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const fileNameRaw = args["fileName"];
  const fileName = typeof fileNameRaw === "string" && fileNameRaw.length > 0 ? fileNameRaw : "build.tar.gz";
  const excludeRaw = args["exclude"];
  const extra = Array.isArray(excludeRaw) ? excludeRaw.filter((entry): entry is string => typeof entry === "string") : [];
  const dirRaw = args["dir"];
  const dir = typeof dirRaw === "string" && dirRaw.length > 0 ? dirRaw : null;
  const targetsRaw = args["targets"];
  const targets = Array.isArray(targetsRaw) ? targetsRaw.map(parseTargetProbe).filter((probe): probe is TargetProbe => probe !== null) : [];
  return { fileName, exclude: [...new Set([...DEFAULT_EXCLUDES, ...extra])], dir, targets };
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

/** Builds the delivery manifest by hashing every file the archive packed —
 *  read straight off disk, not the tar's own listing (which has no hashes),
 *  skipping the same directories `tarDirectory` excludes so the list
 *  matches what the archive contains. The file list is capped
 *  (`MANIFEST_FILE_CAP`); `fileCount` always reports the real total. */
async function buildManifest(
  attempt: string,
  targetDir: string,
  exclude: string[],
  archive: { fileName: string; sizeBytes: number; sha256: string },
): Promise<DeliveryManifestContent> {
  const hashed = await hashTree(targetDir, new Set(exclude));
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
 *  the manifest, returning what the model is told. `manifestNodeId` names
 *  the archive the checks ran against: its artifact, or its hash when no
 *  artifact exists. */
async function verifyAndRecord(
  manifest: DeliveryManifestContent,
  archiveBytes: Buffer,
  manifestNodeId: string,
  args: PublishWorkspaceArgs,
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
    targets: verification.targets.map((target) => ({ target: target.target, ranSuccessfully: target.ranSuccessfully, transcript: target.transcript })),
  };
}

/** Pulls the attempt number out of a `dir` like "attempts/3" for the
 *  artifact's `variant`/title; "1" when `dir` names no attempt (e.g. "."). */
export function attemptVariant(dir: string): string {
  const match = /(\d+)(?!.*\d)/.exec(dir);
  return `attempt-${match ? match[1] : "1"}`;
}

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

/**
 * Packages one attempt directory and runs the deterministic checks on the
 * archive: the same archive, hashes and target probes whether this runs in
 * a specialist's sidecar (the tool's data-URI fallback below) or on the
 * host, where the bounded build bridge keeps its attempts. The archive
 * comes back inline as a `data:` URI with its manifest, which is the shape
 * the client already persists as the stage's `build_evidence`.
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
      `publish_workspace: the archive is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit — ` +
        `exclude node_modules/build output and retry.`,
    );
  }
  const dataUri = `data:${BUNDLE_MEDIA_TYPE};base64,${bytes.toString("base64")}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = await buildManifest(input.attempt, input.dir, exclude, { fileName, sizeBytes: bytes.byteLength, sha256 });
  const verification = await verifyAndRecord(manifest, bytes, `sha256:${sha256}`, { fileName, exclude, dir: null, targets }, input.dir, input.ranOn ?? "sidecar");
  return { fileName, mediaType: BUNDLE_MEDIA_TYPE, sizeBytes: bytes.byteLength, sha256, dataUri, manifest, verification };
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
  rawArgs: Record<string, unknown>,
): Promise<UploadResult | FallbackResult> {
  const args = parseArgs(rawArgs);
  // What is archived is the current attempt, which the workspace already
  // knows; the model naming it adds nothing and is one more thing to get
  // wrong, so an unnamed directory is worked out here instead of refused.
  const dir = args.dir ?? (await currentAttemptDir(env.toolCwd));
  const targetDir = resolveDir(env.toolCwd, dir);

  const hub = await resolveHubFetch(env.capabilities);
  if (!hub) {
    // No artifact-upload credential, so the archive would have to be pasted
    // into a mail reply: the lower cap applies.
    const packaged = await packageAttempt({ dir: targetDir, attempt: attemptVariant(dir), fileName: args.fileName, exclude: args.exclude, targets: args.targets });
    return {
      fallback: "data-uri",
      fileName: packaged.fileName,
      mediaType: packaged.mediaType,
      sizeBytes: packaged.sizeBytes,
      dataUri: packaged.dataUri,
      manifest: packaged.manifest,
      verification: packaged.verification,
    };
  }

  const bytes = await tarDirectory(targetDir, args.exclude);
  if (bytes.byteLength === 0) {
    throw new Error("publish_workspace: the tar produced no bytes — is the workspace empty?");
  }

  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `publish_workspace: the archive is ${bytes.byteLength} bytes, over the ${MAX_ARCHIVE_BYTES}-byte limit — ` +
        `exclude build outputs (e.g. compiled bundles, caches, lockfile-installed vendor trees) with "exclude" and try again.`,
    );
  }

  try {
    const variant = attemptVariant(dir);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // The project is the run's tenant; the hub stamps `sb.projectId` from
    // its resolved run scope, so nothing here names it (#41 step 5).
    const title = `build-${variant}.tar.gz`;
    const created = await uploadArtifact(hub.fetch, env.address, {
      fileName: title,
      mimeType: BUNDLE_MEDIA_TYPE,
      bytes,
      metadata: {
        sb: {
          kind: BUILD_EVIDENCE_KIND,
          stage: 8,
          mediaType: BUNDLE_MEDIA_TYPE,
          variant,
          sourceVersionIds: [],
          // The run's own principal made this; the hub's run-scoped mount
          // labels it. No specialist role is claimed for it here.
          provenance: { producer: "agent" },
        },
      },
    });

    const manifestContent = await buildManifest(variant, targetDir, args.exclude, {
      fileName: title,
      sizeBytes: bytes.byteLength,
      sha256,
    });
    const verification = await verifyAndRecord(manifestContent, bytes, `${created.id}@${String(created.version)}`, args, targetDir, "sidecar");
    const manifestBytes = Buffer.from(JSON.stringify(manifestContent), "utf8");
    const manifestCreated = await uploadArtifact(hub.fetch, env.address, {
      fileName: `build-${variant}-manifest.json`,
      mimeType: MANIFEST_MEDIA_TYPE,
      bytes: manifestBytes,
      metadata: {
        sb: {
          kind: DELIVERY_MANIFEST_KIND,
          stage: 8,
          mediaType: MANIFEST_MEDIA_TYPE,
          variant,
          sourceVersionIds: [created.id],
          provenance: { producer: "agent" },
        },
      },
    });

    return {
      artifactId: created.id,
      version: created.version,
      sha256,
      sizeBytes: bytes.byteLength,
      fileCount: manifestContent.fileCount,
      dir,
      manifest: {
        artifactId: manifestCreated.id,
        version: manifestCreated.version,
        fileCount: manifestContent.fileCount,
        truncated: manifestContent.truncated,
      },
      verification,
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
    targets: {
      type: "array",
      description:
        'The web or api targets this build serves, each with the exact command that starts it from the attempt directory and the port it listens on. The tool starts each one and probes it over HTTP; the result is recorded, not your description of it. E.g. [{ "target": "web", "command": ["bun", "run", "start"], "port": 3000 }, { "target": "api", "command": "bun src/server.ts", "port": 8080, "routes": ["/health"] }].',
      items: {
        type: "object",
        properties: {
          target: { type: "string", description: 'The declared target, e.g. "web" or "api".' },
          command: { description: "The start command: an argv array, or one shell string.", oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
          port: { type: "integer", description: "The port the started process listens on." },
          routes: { type: "array", items: { type: "string" }, description: 'api: routes to GET once the port is open, e.g. ["/", "/health"].' },
          path: { type: "string", description: 'web: the page to fetch; "/" when unset.' },
        },
        required: ["target", "command", "port"],
      },
    },
  },
} as const;

const DESCRIPTION =
  "Archives the build attempt, checks it, and records it as the artifact the person approves. It finds the current attempt itself; pass \"targets\" naming each web or api target's real start command and port so the tool can start and probe it. Everything else is optional and only overrides what it works out.";

/**
 * Builds this tool. It is bound to no project (#41 step 5, decision A): a
 * specialist runs in its project's own tenant (#29), so the project is the
 * run's tenant, stamped onto what this uploads by the hub's run-scoped mount
 * -- never something the model supplies, and no longer a render-time
 * constant either, so the same entry serves every project.
 */
export function publishWorkspaceTool() {
  return defineTool<PublishWorkspaceEnv>({
    id: "@solutions-builder/tools-delivery/publish-workspace",
    requires: ["toolCwd", "capabilities", "address"],
    definitions: [{ name: TOOL_NAME, approval: "ask" as const }],
    factory: (env) => ({
      definitions: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA as unknown as Record<string, unknown> }],
      run: async (call, signal) => {
        try {
          signal.throwIfAborted();
          const result = await publishWorkspaceContent(env, call.arguments);
          return { callId: call.id, content: JSON.stringify(result) };
        } catch (err) {
          return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    }),
  });
}
