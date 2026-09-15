/**
 * The completed build as an artifact, and its acceptance as evidence.
 *
 * A worker leaves its work as a directory under `builds/<runId>`. When the
 * worker ends, that directory is packaged into one archive named after the
 * project — `<project>.tar.gz`, unpacking into a directory of the project's
 * name — and recorded as a `build_evidence` version, so the build stands
 * beside the plan, the packet and the decks and can be saved from the app
 * before anyone decides what it was. Accepting the evidence then issues
 * `build.accept_evidence` through the guard with that archive as the one
 * descriptor, hashed and sized, which is what stage 9 verifies byte for byte.
 *
 * The archive is written inside the workspace, under `.solutions-builder/`,
 * because a descriptor's path must stay inside the workspace it describes.
 * It leaves out the hook the bridge placed, installed dependencies, and
 * itself.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, type Actor, type CommandOutcome } from "./engine.js";
import { HostError } from "./errors.js";
import { newId } from "./ids.js";
import { dataDirectory } from "./paths.js";
import { projectDetail, readArtifactNode, writeArtifact } from "./projects.js";
import { buildEvents } from "./engine-ledger.js";
import { workspaceFor } from "./corbits-exec.js";
import { recordStage8PanelReview } from "./build-review.js";
import { verifierReportOf, type CompletionVerdict } from "./completion-judge.js";

export const BUILD_ARCHIVE_MEDIA_TYPE = "application/gzip";

/** Inside the workspace, out of the worker's way, and out of the archive. */
const ARCHIVE_DIRECTORY = ".solutions-builder";

/** What the archive leaves out: the bridge's hook, packet and seeded skills, version control, installed dependencies, and itself. */
const ARCHIVE_EXCLUDES = new Set([".corbits", ".agents", ".git", "node_modules", ARCHIVE_DIRECTORY]);

/** The archive's store limit, as for decks: past this it is a file the version points at. */
const STORE_LIMIT_BYTES = 11 * 1024 * 1024;

/** The project's name as a file and directory name: lower case, hyphens, nothing a shell minds. */
export function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "project"
  );
}

/** `<project>.tar.gz`, unpacking into `<project>/`. */
export function buildArchiveName(projectTitle: string): string {
  return `${slugOf(projectTitle)}.tar.gz`;
}

export type PackagedBuild = {
  /** Relative to the workspace, as a delivery descriptor names it. */
  readonly path: string;
  readonly absolutePath: string;
  readonly name: string;
  /** The directory the archive unpacks into. */
  readonly root: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

/**
 * Packages a build attempt's workspace into one archive named after the
 * project, with everything under a top-level directory of the project's
 * name. The workspace is staged under that name first, because that is the
 * one way both tar implementations in use write the same paths.
 */
export async function packageBuild(runId: string, projectTitle: string): Promise<PackagedBuild> {
  const workspace = await workspaceFor(runId);
  const root = slugOf(projectTitle);
  const name = `${root}.tar.gz`;
  const directory = join(workspace, ARCHIVE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const absolutePath = join(directory, name);

  const staging = await mkdtemp(join(tmpdir(), "solutions-builder-archive-"));
  try {
    await cp(workspace, join(staging, root), {
      recursive: true,
      filter: (source) => !ARCHIVE_EXCLUDES.has(source.slice(workspace.length + 1).split("/")[0] ?? ""),
    });
    const tar = Bun.spawn(["tar", "-czf", absolutePath, "-C", staging, root], { stdout: "ignore", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    if (exit !== 0) {
      throw new HostError("internal_error", `The build could not be packaged: tar exited ${exit}. ${stderr.trim()}`.trim());
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const bytes = await readFile(absolutePath);
  return {
    path: `${ARCHIVE_DIRECTORY}/${name}`,
    absolutePath,
    name,
    root,
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
  await cp(archive.absolutePath, join(buildFilesDirectory(), name));
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

/** What a build's final event carries about its archive, once it is packaged. */
export type BuildArchive = {
  readonly nodeId: string;
  readonly name: string;
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

/**
 * Packages an ended attempt's workspace and records it as the project's
 * build, a `build_evidence` version titled with the project's name and
 * produced by the attempt. Done when the worker ends, before anyone has
 * judged the work: the archive is the work as left, whatever the verdict.
 */
export async function recordBuildArchive(args: {
  actor: Actor;
  projectId: string;
  runId: string;
}): Promise<BuildArchive> {
  const detail = await projectDetail(args.projectId, args.actor.principalId);
  const run = detail.runs.find((entry) => entry.id === args.runId);
  const archive = await packageBuild(args.runId, detail.project.title);
  const version = await writeArtifact(
    {
      projectId: args.projectId,
      kind: "build_evidence",
      title: detail.project.title,
      content: await buildContent(archive),
      mediaType: BUILD_ARCHIVE_MEDIA_TYPE,
      // The packet the build was run against is the version this came from.
      sourceVersionIds: run?.packetId ? [run.packetId] : [],
      provenance: { producer: "human", runId: args.runId },
    },
    args.actor,
  );
  return { nodeId: version.nodeId, name: archive.name, root: archive.root, path: archive.path, sha256: archive.sha256, sizeBytes: archive.sizeBytes };
}

export type AcceptedBuild = {
  readonly run: CommandOutcome;
  readonly artifact: { nodeId: string; title: string; name: string; sizeBytes: number };
};

/**
 * Accepts an ended attempt's work as the build's evidence: the archive
 * recorded when the worker ended — packaged now if that attempt predates
 * the packaging, or the file is gone — is what the ledger moves to delivery
 * review with, as the one thing stage 9 must verify. Refused while the
 * worker is still running, and for a run that is not a build attempt.
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
    archive?: BuildArchive | null;
    completion?: CompletionVerdict | null;
  };

  const archive = (await stillThere(args.runId, reported.archive)) ?? (await recordBuildArchive({ actor: args.actor, projectId: args.projectId, runId: args.runId }));
  const { node: version, content: archiveContent } = await readArtifactNode(archive.nodeId);

  // The completion judge's own verdict on the attempt just ended
  // (`completion-judge.ts`, recorded onto this same `bridge.final` event by
  // `build-attempt.ts`) is the verifier report `build.accept_evidence`
  // requires. A worker that never ran the judge (unavailable, or timed out
  // before its first check) reports none, and the engine refuses this
  // acceptance rather than accepting unverified evidence.
  const verifierReport = reported.completion ? verifierReportOf(reported.completion) : null;

  const outcome = await execute({
    type: "build.accept_evidence",
    actor: args.actor,
    projectId: args.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
    payload: {
      runId: args.runId,
      versions: [{ artifactId: version.artifactId, versionId: version.id, contentHash: version.contentHash }],
      verifierReport,
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
        evidenceVersionId: archive.nodeId,
      },
    },
  });

  // The panel reviews the accepted evidence now, not the person's approval:
  // it may require revision, evidence or remediation, but decides nothing,
  // so its four findings are recorded and never held against acceptance.
  await recordStage8PanelReview({
    projectId: args.projectId,
    actor: args.actor,
    archive,
    content: archiveContent,
    report: {
      worker: reported.worker ?? null,
      exitStatus: reported.exitStatus ?? null,
      turns: reported.turns ?? null,
      toolCalls: reported.toolCalls ?? null,
      continuedFrom: reported.continuedFrom ?? null,
    },
  });

  return {
    run: outcome,
    artifact: { nodeId: archive.nodeId, title: version.title, name: archive.name, sizeBytes: archive.sizeBytes },
  };
}

/** The archive the final event named, when its file is still in the workspace with the same bytes. */
async function stillThere(runId: string, archive: BuildArchive | null | undefined): Promise<BuildArchive | null> {
  if (!archive) return null;
  try {
    const bytes = await readFile(join(await workspaceFor(runId), archive.path));
    return createHash("sha256").update(bytes).digest("hex") === archive.sha256 ? archive : null;
  } catch {
    return null;
  }
}
