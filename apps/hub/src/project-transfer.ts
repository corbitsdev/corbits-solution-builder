/**
 * A project, carried to another instance of the app.
 *
 * Everything the product records about a project is one of two things: a
 * turn on its ledger, or a version of an artifact (docs/ARCHITECTURE.md).
 * So a project travels as exactly those — every ledger turn as it was
 * recorded, every artifact node with its bytes — plus the tenant record
 * that names it. Nothing else is durable, and nothing else is carried:
 * not a provider, not a credential, not the run the platform holds, which
 * is rebuilt from the ledger on the first command the imported project
 * receives.
 *
 * Import does not re-decide anything. The ledger is replayed entry by
 * entry, so the runs, approvals, decisions and flags fold out of it exactly
 * as they did at home, with the same run ids and the same version ids. Only
 * the ids the receiving instance has to mint — the project's, and the
 * artifact store's, and the node ids, so a bundle can come back into the
 * workspace it left — change, and every mention of the old ones in the
 * carried ledger and records is rewritten to the new.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { HostError, notFound } from "./errors.js";
import {
  ledgerEntries,
  projectBuildEvents,
  recordBuildEvent,
  recordCarriedTurns,
  recordCommand,
  type BuildEvent,
  type CarriedTurn,
  type LedgerEntry,
} from "./engine-ledger.js";
import { portableThread } from "./stage-thread.js";
import { STAGES } from "@solutions-builder/app/ledger";
import { launchProjectRun } from "./engine.js";
import {
  exportArtifactNodes,
  importArtifactNodes,
  rewriteIds,
  type PortableArtifactNode,
} from "./projects.js";
import { createProjectRecord, readProject, updateProject } from "./installer-bridge.js";
import type { ProjectPolicy } from "@solutions-builder/installer";

export const BUNDLE_FORMAT = "solutions-builder.project";
export const BUNDLE_VERSION = 1;

export type ProjectBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  project: {
    id: string;
    title: string;
    policy: ProjectPolicy;
    archivedAt: string | null;
    createdAt: string;
  };
  /** Every ledger turn as recorded, oldest first. */
  ledger: { startedAt: string; metadata: Record<string, unknown> }[];
  /** Every worker event, every run, oldest first. */
  buildEvents: BuildEvent[];
  /**
   * The conversation with each stage's specialist, oldest turn first —
   * questions included, so one left open at home is still open here. Absent
   * from bundles written before it was carried.
   */
  conversations?: { stage: number; turns: CarriedTurn[] }[];
  artifacts: {
    nodes: PortableArtifactNode[];
    edges: { childNodeId: string; sourceNodeId: string }[];
  };
};

export async function exportProject(projectId: string): Promise<ProjectBundle> {
  const project = await readProject(projectId);
  if (!project) throw notFound("That project");
  const [ledger, buildEvents, artifacts] = await Promise.all([
    ledgerEntries(projectId),
    projectBuildEvents(projectId),
    exportArtifactNodes(projectId),
  ]);
  const conversations: { stage: number; turns: CarriedTurn[] }[] = [];
  for (const stage of STAGES) {
    const turns = await portableThread(projectId, stage);
    if (turns.length > 0) conversations.push({ stage, turns: turns.map((turn) => ({ ...turn, quotes: [...turn.quotes] })) });
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      title: project.title,
      policy: project.policy,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      createdAt: project.createdAt.toISOString(),
    },
    ledger,
    buildEvents,
    conversations,
    artifacts,
  };
}

/** A file name for the bundle: the title, made safe, with the app's own suffix. */
export function bundleFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "project"}.solutions-builder.json`;
}

/** Where an export lands when the person asks for a file: the Downloads folder, unless told otherwise. */
export function exportDirectory(): string {
  return process.env.SOLUTIONS_BUILDER_EXPORT_DIR?.trim() || join(homedir(), "Downloads");
}

/** A file name for an artifact: its title, slugged, with the extension its type implies. */
export function fileNameFor(title: string, mime: string): string {
  const extension =
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ? "pptx"
      : mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ? "xlsx"
        : mime === "application/pdf"
          ? "pdf"
          : mime === "application/gzip"
            ? "tar.gz"
            : (mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]+/g, "").slice(0, 8) || "bin";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "file";
  return `${slug}.${extension}`;
}

/** Writes bytes as a file in the directory, never over one that is already there. */
export async function saveFile(name: string, bytes: Uint8Array, directory: string): Promise<{ path: string; bytes: number }> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let path = join(directory, name);
  for (let n = 2; await Bun.file(path).exists(); n += 1) {
    path = join(directory, `${stem}-${n}${extension}`);
  }
  await Bun.write(path, bytes);
  return { path, bytes: bytes.byteLength };
}

/** Writes the bundle as a file, never over one that is already there. */
export async function saveBundle(bundle: ProjectBundle, directory: string): Promise<{ path: string; bytes: number }> {
  const base = bundleFileName(bundle.project.title);
  let path = join(directory, base);
  for (let n = 2; await Bun.file(path).exists(); n += 1) {
    path = join(directory, base.replace(/\.solutions-builder\.json$/, `-${n}.solutions-builder.json`));
  }
  const text = JSON.stringify(bundle, null, 2);
  await Bun.write(path, text);
  return { path, bytes: new TextEncoder().encode(text).length };
}

/** The shape check a bundle gets before anything is written: format, version, and the parts that must be there. */
export function parseBundle(raw: unknown): ProjectBundle {
  const bundle = raw as Partial<ProjectBundle> | null;
  if (!bundle || typeof bundle !== "object") {
    throw new HostError("validation_failed", "That file is not a Solutions Builder project export.");
  }
  if (bundle.format !== BUNDLE_FORMAT) {
    throw new HostError("validation_failed", "That file is not a Solutions Builder project export.");
  }
  if (bundle.version !== BUNDLE_VERSION) {
    throw new HostError(
      "validation_failed",
      `That export is format version ${String(bundle.version)}; this app reads version ${BUNDLE_VERSION}.`,
    );
  }
  if (!bundle.project?.title || !bundle.project.policy || !Array.isArray(bundle.ledger) || !bundle.artifacts) {
    throw new HostError("validation_failed", "That export is missing its project, ledger or artifacts.");
  }
  if (!bundle.ledger.some((entry) => entry.metadata?.command === "project.create")) {
    throw new HostError("validation_failed", "That export has no opening command; it cannot be replayed.");
  }
  return bundle as ProjectBundle;
}

/** A recorded turn's metadata back into the entry that produced it. */
function entryFromMetadata(projectId: string, metadata: Record<string, unknown>): LedgerEntry {
  const pick = <T,>(key: string): T | undefined => (key in metadata ? (metadata[key] as T) : undefined);
  return {
    projectId,
    actorPrincipalId: String(metadata.actorPrincipalId ?? ""),
    authority: (metadata.authority as string | null | undefined) ?? null,
    command: String(metadata.command),
    transitionId: (metadata.transitionId as string | null | undefined) ?? null,
    correlationId: String(metadata.correlationId ?? ""),
    before: metadata.before ?? null,
    after: metadata.after ?? null,
    idempotencyKey: String(metadata.idempotencyKey ?? ""),
    result: metadata.result as LedgerEntry["result"],
    ...(pick("decision") !== undefined ? { decision: pick<string>("decision") } : {}),
    ...(pick("audienceName") !== undefined ? { audienceName: pick<string | null>("audienceName") } : {}),
    ...(pick("versions") !== undefined ? { versions: pick("versions") } : {}),
    ...(pick("rationale") !== undefined ? { rationale: pick<string | null>("rationale") } : {}),
    ...(pick("assumptions") !== undefined ? { assumptions: pick("assumptions") } : {}),
    ...(pick("stage") !== undefined ? { stage: pick<number>("stage") } : {}),
    ...(pick("runId") !== undefined ? { runId: pick<string>("runId") } : {}),
    ...(pick("runs") !== undefined ? { runs: pick<LedgerEntry["runs"]>("runs") } : {}),
    ...(pick("flag") !== undefined ? { flag: pick<LedgerEntry["flag"]>("flag") } : {}),
    ...(pick("question") !== undefined ? { question: pick<LedgerEntry["question"]>("question") } : {}),
    ...(pick("answer") !== undefined ? { answer: pick<LedgerEntry["answer"]>("answer") } : {}),
    ...(pick("receipt") !== undefined ? { receipt: pick<LedgerEntry["receipt"]>("receipt") } : {}),
    ...(pick("message") !== undefined ? { message: pick<string>("message") } : {}),
  } as LedgerEntry;
}

/**
 * Brings a carried project into this instance as a new project. Returns
 * its id here. The run the platform holds is fired at the end and brought
 * to the ledger's stage on the first command, as any project's is.
 */
export async function importProject(
  bundle: ProjectBundle,
  actor: { principalId: string },
): Promise<{ projectId: string; nodes: number; commands: number }> {
  const record = await createProjectRecord({ title: bundle.project.title, policy: bundle.project.policy });
  const ids = new Map<string, string>([[bundle.project.id, record.id]]);
  const minted = await importArtifactNodes({
    projectId: record.id,
    nodes: bundle.artifacts.nodes,
    edges: bundle.artifacts.edges,
    actor,
  });
  for (const [carried, here] of minted) ids.set(carried, here);

  for (const entry of bundle.ledger) {
    const metadata = rewriteIds(entry.metadata, ids) as Record<string, unknown>;
    await recordCommand(entryFromMetadata(record.id, metadata));
  }
  for (const event of bundle.buildEvents) {
    await recordBuildEvent(record.id, rewriteIds(event, ids) as BuildEvent);
  }
  for (const conversation of bundle.conversations ?? []) {
    await recordCarriedTurns(record.id, conversation.stage, rewriteIds(conversation.turns, ids) as CarriedTurn[]);
  }
  if (bundle.project.archivedAt) {
    await updateProject(record.id, { archivedAt: new Date(bundle.project.archivedAt) });
  }
  await launchProjectRun({ projectId: record.id });
  return { projectId: record.id, nodes: bundle.artifacts.nodes.length, commands: bundle.ledger.length };
}
