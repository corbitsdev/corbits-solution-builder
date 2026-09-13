/**
 * The completed build as an artifact, and its acceptance as evidence.
 *
 * A worker leaves its work as a directory under `builds/<runId>`. Accepting
 * that as evidence means three things, done here in order: the directory is
 * packaged into one archive named after the project; the archive is recorded
 * as a `build_evidence` version so it stands beside the plan, the packet and
 * the decks and can be saved from the app; and `build.accept_evidence` is
 * issued through the guard with one descriptor — that archive, hashed and
 * sized — which is what stage 9 verifies byte for byte.
 *
 * The archive is written inside the workspace, under `.solutions-builder/`,
 * because a descriptor's path must stay inside the workspace it describes.
 * It leaves out the hook the bridge placed, installed dependencies, and
 * itself.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, type Actor, type CommandOutcome } from "./engine.js";
import { HostError } from "./errors.js";
import { newId } from "./ids.js";
import { dataDirectory } from "./paths.js";
import { projectDetail, writeArtifact } from "./projects.js";
import { buildEvents } from "./engine-ledger.js";
import { workspaceFor } from "./corbits-exec.js";

export const BUILD_ARCHIVE_MEDIA_TYPE = "application/gzip";

/** Inside the workspace, out of the worker's way, and out of the archive. */
const ARCHIVE_DIRECTORY = ".solutions-builder";

/** What the archive leaves out: the bridge's hook, installed dependencies, and itself. */
const ARCHIVE_EXCLUDES = [".corbits", "node_modules", ARCHIVE_DIRECTORY];

/** The archive's store limit, as for decks: past this it is a file the version points at. */
const STORE_LIMIT_BYTES = 11 * 1024 * 1024;

export function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "project"
  );
}

/** `<project>-build.tar.gz`: the project's name is the file's. */
export function buildArchiveName(projectTitle: string): string {
  return `${slugOf(projectTitle)}-build.tar.gz`;
}

export type PackagedBuild = {
  /** Relative to the workspace, as a delivery descriptor names it. */
  readonly path: string;
  readonly absolutePath: string;
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

/** Packages a build attempt's workspace into one archive named after the project. */
export async function packageBuild(runId: string, projectTitle: string): Promise<PackagedBuild> {
  const workspace = await workspaceFor(runId);
  const name = buildArchiveName(projectTitle);
  const directory = join(workspace, ARCHIVE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const absolutePath = join(directory, name);
  const tar = Bun.spawn(
    ["tar", "-czf", absolutePath, "-C", workspace, ...ARCHIVE_EXCLUDES.flatMap((entry) => ["--exclude", `./${entry}`]), "."],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (exit !== 0) {
    throw new HostError("internal_error", `The build could not be packaged: tar exited ${exit}. ${stderr.trim()}`.trim());
  }
  const bytes = await readFile(absolutePath);
  return {
    path: `${ARCHIVE_DIRECTORY}/${name}`,
    absolutePath,
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: (await stat(absolutePath)).size,
  };
}

function buildFilesDirectory(): string {
  return join(dataDirectory(), "build-outputs");
}

/** The version's content: the bytes as a data URI when they fit the store, else a pointer to a copy kept beside the workspaces. */
async function buildContent(archive: PackagedBuild): Promise<string> {
  const bytes = await readFile(archive.absolutePath);
  if (bytes.byteLength <= STORE_LIMIT_BYTES) return `data:${BUILD_ARCHIVE_MEDIA_TYPE};base64,${bytes.toString("base64")}`;
  const name = `${archive.sha256.slice(0, 32)}.tar.gz`;
  await mkdir(buildFilesDirectory(), { recursive: true });
  await writeFile(join(buildFilesDirectory(), name), bytes);
  return JSON.stringify({ buildFile: name, bytes: bytes.byteLength });
}

/** A build version's bytes, from the store or from the file it points at; null when the file is gone. */
export async function buildBytesOf(content: string): Promise<Uint8Array | null> {
  const inline = /^data:[^;]+;base64,(.*)$/s.exec(content);
  if (inline) return new Uint8Array(Buffer.from(inline[1]!, "base64"));
  try {
    const pointer = JSON.parse(content) as { buildFile?: unknown };
    if (typeof pointer.buildFile !== "string" || !/^[a-f0-9]+\.tar\.gz$/.test(pointer.buildFile)) return null;
    return new Uint8Array(await readFile(join(buildFilesDirectory(), pointer.buildFile)));
  } catch {
    return null;
  }
}

export type AcceptedBuild = {
  readonly run: CommandOutcome;
  readonly artifact: { nodeId: string; artifactId: string; version: number; title: string; name: string; sizeBytes: number };
};

/**
 * Accepts an ended attempt's work as the build's evidence: packages it,
 * records the archive as a version of the project, and moves the ledger to
 * delivery review with the archive as the one thing stage 9 must verify.
 * Refused while the worker is still running — there is nothing to accept
 * until it has ended — and for a run that is not a build attempt.
 */
export async function acceptBuildEvidence(args: {
  actor: Actor;
  projectId: string;
  runId: string;
  expectedRevision?: number;
}): Promise<AcceptedBuild> {
  const detail = await projectDetail(args.projectId, args.actor.principalId);
  const run = detail.runs.find((entry) => entry.id === args.runId);
  if (!run || run.kind !== "build") throw new HostError("not_found", "That build attempt is not on this project.");
  const final = (await buildEvents(args.projectId, args.runId)).find((event) => event.type === "bridge.final");
  if (!final) {
    throw new HostError("conflict", "The worker has not ended. Its work can be accepted once it has.", {}, false);
  }
  const reported = final.payload as {
    worker?: string;
    exitStatus?: number | null;
    turns?: number | null;
    toolCalls?: number | null;
    continuedFrom?: string | null;
  };

  const archive = await packageBuild(args.runId, detail.project.title);
  const title = `${detail.project.title} build`;
  const version = await writeArtifact(
    {
      projectId: args.projectId,
      kind: "build_evidence",
      title,
      content: await buildContent(archive),
      mediaType: BUILD_ARCHIVE_MEDIA_TYPE,
      // The packet the build was run against is the version this came from.
      sourceVersionIds: run.packetId ? [run.packetId] : [],
      provenance: { producer: "human", runId: args.runId },
    },
    args.actor,
  );

  const outcome = await execute({
    type: "build.accept_evidence",
    actor: args.actor,
    projectId: args.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
    payload: {
      runId: args.runId,
      versions: [{ artifactId: version.artifactId, versionId: version.nodeId, contentHash: version.contentHash }],
      descriptors: [
        {
          category: "source",
          path: archive.path,
          sha256: archive.sha256,
          sizeBytes: archive.sizeBytes,
          mediaType: BUILD_ARCHIVE_MEDIA_TYPE,
          access: "local",
          required: true,
        },
      ],
      // What was known when the person accepted: the worker's own numbers,
      // and the archive they accepted. Not a verifier's report; stage 9's is.
      verification: {
        acceptedFrom: "the build supervision screen",
        worker: reported.worker ?? null,
        exitStatus: reported.exitStatus ?? null,
        turns: reported.turns ?? null,
        toolCalls: reported.toolCalls ?? null,
        continuedFrom: reported.continuedFrom ?? null,
        archive: { name: archive.name, sha256: archive.sha256, sizeBytes: archive.sizeBytes },
        evidenceVersionId: version.nodeId,
      },
    },
  });

  return {
    run: outcome,
    artifact: {
      nodeId: version.nodeId,
      artifactId: version.artifactId,
      version: version.version,
      title,
      name: archive.name,
      sizeBytes: archive.sizeBytes,
    },
  };
}
