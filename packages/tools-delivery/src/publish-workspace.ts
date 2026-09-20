/**
 * `publish_workspace` — tars the run's build workspace so the delivered
 * software survives past the run's release. Without this, everything a
 * stage 8/9 specialist writes with `run_shell` lives only in the run's warm
 * allocation (`<hub data>/process-provisioner/allocations/<sal>/gen-N/data/
 * workflow-step-state/<run>/warm/run/workspace/`) and is gone once the run
 * is released — `delivery_status` only ever records a manifest of paths and
 * hashes, never the bytes.
 *
 * No sidecar tool env carries hub credentials or a tenant transport (see
 * `@intx/agent`'s `BaseEnv`), so this cannot call the mounted
 * `@corbits/artifacts` route itself. It returns the archive as a `data:`
 * URI in the tool result instead, the same convention
 * `@solutions-builder/tools-deck`'s `render_deck` uses for its rendered
 * PowerPoint — the client persists it as an artifact once the person
 * approves, same as every other write in this app.
 */
import { defineTool, type BaseEnv } from "@intx/agent";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";

export const TOOL_NAME = "publish_workspace";

export const BUNDLE_MEDIA_TYPE = "application/gzip";

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
 *  commands operate on, same key `@intx/tools-posix` declares. */
export interface PublishWorkspaceEnv extends BaseEnv {
  toolCwd: string;
}

type PublishWorkspaceArgs = {
  fileName: string;
  exclude: string[];
  dir: string;
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
  return new Promise((resolve, reject) => {
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
      resolve(Buffer.concat(chunks));
    });
  });
}

async function publishWorkspaceContent(cwd: string, rawArgs: Record<string, unknown>): Promise<string> {
  const args = parseArgs(rawArgs);
  const targetDir = resolveDir(cwd, args.dir);
  const bytes = await tarDirectory(targetDir, args.exclude);
  if (bytes.byteLength === 0) {
    throw new Error("publish_workspace: the tar produced no bytes — is the workspace empty?");
  }
  const dataUri = `data:${BUNDLE_MEDIA_TYPE};base64,${bytes.toString("base64")}`;
  return JSON.stringify({ fileName: args.fileName, mediaType: BUNDLE_MEDIA_TYPE, sizeBytes: bytes.byteLength, dataUri });
}

/** Named export the sidecar loader picks up. */
export const publishWorkspace = defineTool<PublishWorkspaceEnv>({
  id: "@solutions-builder/tools-delivery/publish-workspace",
  requires: ["toolCwd"],
  definitions: [{ name: TOOL_NAME, approval: "ask" as const }],
  factory: (env) => ({
    definitions: [
      {
        name: TOOL_NAME,
        description:
          "Archives one directory of the run's build workspace (excluding node_modules/.git/dist/build caches) as a gzip tarball and returns it as a data: URI in the tool result, so the person can save it as a downloadable artifact when they approve this stage. Does not touch the hub itself — the client persists the artifact.",
        inputSchema: {
          type: "object",
          properties: {
            dir: {
              type: "string",
              description: 'The attempt directory to archive, relative to the working directory, e.g. "attempts/3". Defaults to the working directory itself.',
            },
            fileName: { type: "string", description: 'Archive file name, e.g. "my-project.tar.gz". Defaults to "build.tar.gz".' },
            exclude: {
              type: "array",
              items: { type: "string" },
              description: "Additional path patterns to exclude, beyond node_modules/.git/.venv/__pycache__/dist/.cache/.turbo/.next/coverage.",
            },
          },
        },
      },
    ],
    run: async (call, signal) => {
      try {
        signal.throwIfAborted();
        const content = await publishWorkspaceContent(env.toolCwd, call.arguments);
        return { callId: call.id, content };
      } catch (err) {
        return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  }),
});
