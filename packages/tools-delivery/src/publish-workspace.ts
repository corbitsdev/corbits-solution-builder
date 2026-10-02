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
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { BUILD_EVIDENCE_KIND, DELIVERY_MANIFEST_KIND } from "@solutions-builder/specialist-runtime/artifact-kinds";
import {
  attemptVariant,
  buildManifest,
  BUNDLE_MEDIA_TYPE,
  DEFAULT_EXCLUDES,
  MANIFEST_MEDIA_TYPE,
  packageAttempt,
  parseTargetProbe,
  tarDirectory,
  verifyAndRecord,
  type DeliveryManifestContent,
  type TargetProbe,
  type VerificationSummary,
} from "@solutions-builder/specialist-runtime/package-attempt";

export const TOOL_NAME = "publish_workspace";

/** The packaging itself lives in `@solutions-builder/specialist-runtime/package-attempt`; re-exported for this tool's callers. */
export { attemptVariant, BUNDLE_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, packageAttempt, parseTargetProbe } from "@solutions-builder/specialist-runtime/package-attempt";
export type { DeliveryManifestContent, ManifestFileEntry, PackagedAttempt, TargetProbe, VerificationSummary } from "@solutions-builder/specialist-runtime/package-attempt";

/** Mirrors `@corbits/artifacts`' `MAX_UPLOAD_BYTES` — the ceiling the hub's
 *  binary create route enforces on one uploaded file. Duplicated rather than
 *  imported (see module doc); a drift here only makes this tool's own
 *  pre-check looser or tighter than the hub's, never bypass it. */
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

/** Where a host mounts `mountWorkflowArtifacts`, and the credential handle a
 *  specialist's `credentialBindings` binds to it. Copied from
 *  `@corbits/artifacts/sidecar-bundle` for the same reason as
 *  `MAX_ARCHIVE_BYTES` above. */
const WORKFLOW_ARTIFACTS_BASE_PATH = "/api/workflow-artifacts";
const HUB_CREDENTIAL_HANDLE = "hub";

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
      description: "Additional path patterns to exclude, beyond node_modules/.git/.corbits/.venv/__pycache__/dist/.cache/.turbo/.next/coverage.",
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
