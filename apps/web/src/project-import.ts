/**
 * Importing a project bundle `project-export.ts`'s `assembleBundle` wrote
 * (CL-8725). Every artifact and conversation is recreated fresh under a NEW
 * project id, an artifact's versions written back in the order the export
 * carried them, and its lineage restored: a node is written after the one
 * it supersedes and the ones it was generated from, so its `sb.supersedes`
 * and `sourceVersionIds` can name the artifacts written here (#632). The
 * workflow's position is landed afterwards by `bundle-adoption.ts`, as real
 * decisions on the new project's own workflow (#652); nothing here writes a
 * decision.
 *
 * Mail history cannot be recreated (there is no mailbox to write into before
 * a stage specialist deploys), so each bundled conversation becomes one
 * read-only text artifact instead, `sb.kind: "imported_conversation"`.
 */
import JSZip from "jszip";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { stageName } from "./components.jsx";
import type { ExportedArtifact, ProjectBundle } from "./project-export.ts";

export const IMPORTED_CONVERSATION_KIND = "imported_conversation";

export type ImportWrite = {
  readonly title: string;
  readonly content: string;
  readonly sb: Record<string, unknown>;
};

/**
 * One bundled node's writes, oldest version first: the first creates the
 * artifact, each later one revises it. `supersedes` and `sources` name
 * bundled nodes, which the write resolves to the artifacts written for them.
 */
export type ArtifactImport = {
  readonly nodeId: string;
  /** The bundled node this one replaced in its lineage, if the bundle has it. */
  readonly supersedes: string | null;
  /** The bundled nodes this one was generated from. */
  readonly sources: readonly string[];
  readonly versions: readonly ImportWrite[];
};

export type ImportPlan = {
  readonly artifacts: readonly ArtifactImport[];
  readonly conversations: readonly ImportWrite[];
};

/** `<original title> (imported)`, the new project's title. */
export function importedProjectTitle(bundle: ProjectBundle): string {
  return `${bundle.project.title} (imported)`;
}

/** One stage's messages as the read-only text an `imported_conversation` artifact holds. */
export function transcript(messages: ProjectBundle["conversations"][number]["messages"]): string {
  return messages
    .map((message) => `**${message.author === "me" ? "You" : "Specialist"}** — ${message.at}\n\n${message.body}`)
    .join("\n\n---\n\n");
}

/**
 * The bundled artifacts in the order they can be written so every reference
 * resolves: each after the node it supersedes and the nodes it was
 * generated from, otherwise oldest first, which is also what numbers a
 * lineage's positions. A reference to a node the bundle does not carry is
 * no dependency, and a cycle cannot be honoured: the oldest node still
 * waiting is written next and whatever it referred to that is not yet
 * written is dropped at write time, leaving it a root.
 */
export function writeOrder(artifacts: readonly ExportedArtifact[]): ExportedArtifact[] {
  const bundled = new Set(artifacts.map(({ node }) => node.id));
  const predecessorOf = new Map<string, string>();
  for (const { node } of artifacts) {
    if (node.supersededByNodeId !== null && bundled.has(node.supersededByNodeId) && !predecessorOf.has(node.supersededByNodeId)) {
      predecessorOf.set(node.supersededByNodeId, node.id);
    }
  }
  const dependencies = new Map(
    artifacts.map(({ node, sources }) => {
      const predecessor = predecessorOf.get(node.id);
      return [node.id, [...(predecessor ? [predecessor] : []), ...(sources ?? []).filter((id) => bundled.has(id) && id !== node.id)]];
    }),
  );
  const waiting = artifacts
    .map((artifact, at) => ({ artifact, at }))
    .sort((a, b) => Date.parse(a.artifact.node.createdAt) - Date.parse(b.artifact.node.createdAt) || a.at - b.at)
    .map(({ artifact }) => artifact);
  const placed = new Set<string>();
  const ordered: ExportedArtifact[] = [];
  while (waiting.length > 0) {
    const ready = waiting.findIndex(({ node }) => dependencies.get(node.id)!.every((id) => placed.has(id)));
    const [next] = waiting.splice(ready === -1 ? 0 : ready, 1);
    placed.add(next!.node.id);
    ordered.push(next!);
  }
  return ordered;
}

/** The bundled node `nodeId` replaced in its lineage: the one whose `supersededByNodeId` names it. */
function predecessorIn(bundle: ProjectBundle, nodeId: string): string | null {
  return bundle.artifacts.find(({ node }) => node.supersededByNodeId === nodeId)?.node.id ?? null;
}

/**
 * The pure write plan for one bundle under a freshly created project id: no
 * network, nothing minted here. Every artifact becomes a fresh one with
 * `kind`/`stage`/`variant`/`mediaType`/`provenance` carried over from the
 * bundled node, re-keyed to `newProjectId`, and one write per bundled
 * version, oldest first; a v2 or v3 bundle carried only the current content,
 * so it is one write. The artifacts come in `writeOrder`, each naming the
 * bundled node it supersedes and the ones it was generated from, for the
 * write to resolve; `sb.sourceVersionIds` is empty until then. Content,
 * including a `data:` URL for a binary original, is kept exactly as bundled.
 */
export function importPlan(bundle: ProjectBundle, newProjectId: string): ImportPlan {
  const bundled = new Set(bundle.artifacts.map(({ node }) => node.id));
  const artifacts: ArtifactImport[] = writeOrder(bundle.artifacts).map(({ node, content, versions, sources }) => {
    const sb = {
      projectId: newProjectId,
      kind: node.kind,
      stage: node.stage,
      variant: node.variant,
      sourceVersionIds: [],
      provenance: { ...node.provenance },
      ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
    };
    const chain = versions && versions.length > 0 ? [...versions].sort((a, b) => a.version - b.version).map((entry) => entry.content) : [content];
    return {
      nodeId: node.id,
      supersedes: predecessorIn(bundle, node.id),
      sources: (sources ?? []).filter((id) => bundled.has(id) && id !== node.id),
      versions: chain.map((text) => ({ title: node.title, content: text, sb })),
    };
  });

  return { artifacts, conversations: bundle.conversations.map((conversation) => conversationWrite(conversation, newProjectId)) };
}

/** The transcript artifact one bundled conversation becomes under `newProjectId`. */
export function conversationWrite({ stage, messages }: ProjectBundle["conversations"][number], newProjectId: string): ImportWrite {
  return {
    title: `${stageName(stage)} conversation (imported)`,
    content: transcript(messages),
    sb: {
      projectId: newProjectId,
      kind: IMPORTED_CONVERSATION_KIND,
      stage,
      variant: null,
      sourceVersionIds: [],
      provenance: { producer: "human" as const },
      mediaType: "text/markdown",
    },
  };
}

export type ImportDeps = {
  readonly createProject: (input: { title: string; policy: unknown }) => Promise<{ projectId: string }>;
  /** Creates an artifact, returning the version the store numbered it. */
  readonly createArtifact: (write: ImportWrite) => Promise<{ id: string; version: number }>;
  /** Writes the next version of an artifact, returning the number the store gave it. */
  readonly reviseArtifact: (artifactId: string, write: ImportWrite) => Promise<{ version: number }>;
  /** Called after each write, `done` counting every version and conversation together. */
  readonly onProgress?: (done: number, total: number) => void;
};

/** Where a bundled node landed: the artifact written for it, at the version its last write got. */
export type WrittenArtifact = { readonly artifactId: string; readonly version: number };

export type ImportResult = {
  readonly projectId: string;
  readonly artifacts: number;
  /** Versions written across every artifact. */
  readonly versions: number;
  readonly conversations: number;
  /** What each bundled node became, by the node's id (#652): what the replay re-points approvals at. */
  readonly written: ReadonlyMap<string, WrittenArtifact>;
};

/**
 * A planned write with its lineage resolved to the artifacts written so far:
 * `sb.supersedes` is the predecessor's new id and `sourceVersionIds` the
 * sources' new version ids, in the graph's own `artifactId@version` form.
 * A reference to a node not written yet (a cycle, or one the bundle lacks)
 * is dropped, so the node is a root rather than a dangling edge.
 */
function linked(write: ImportWrite, artifact: ArtifactImport, written: ReadonlyMap<string, WrittenArtifact>): ImportWrite {
  const predecessor = artifact.supersedes === null ? undefined : written.get(artifact.supersedes);
  const sourceVersionIds = artifact.sources.flatMap((id) => {
    const source = written.get(id);
    return source ? [versionIdFor(source.artifactId, source.version)] : [];
  });
  return { ...write, sb: { ...write.sb, sourceVersionIds, ...(predecessor ? { supersedes: predecessor.artifactId } : {}) } };
}

/**
 * Creates the new project, then writes `importPlan`'s versions and
 * conversations into it one at a time -- an artifact-store write has no
 * batch form here, the same as `attachMaterial`. The store numbers the
 * versions as it writes them; what each node landed at is reported, not
 * assumed, since a chain the export could only partly read starts over at 1.
 */
export async function importProject(bundle: ProjectBundle, deps: ImportDeps): Promise<ImportResult> {
  const { projectId } = await deps.createProject({ title: importedProjectTitle(bundle), policy: bundle.project.policy });
  const plan = importPlan(bundle, projectId);
  const written = new Map<string, WrittenArtifact>();
  const total = plan.artifacts.reduce((count, artifact) => count + artifact.versions.length, 0) + plan.conversations.length;
  let done = 0;
  for (const artifact of plan.artifacts) {
    const [first, ...later] = artifact.versions;
    if (!first) continue;
    const created = await deps.createArtifact(linked(first, artifact, written));
    let landed: WrittenArtifact = { artifactId: created.id, version: created.version };
    done += 1;
    deps.onProgress?.(done, total);
    for (const write of later) {
      const revised = await deps.reviseArtifact(created.id, linked(write, artifact, written));
      landed = { artifactId: created.id, version: revised.version };
      done += 1;
      deps.onProgress?.(done, total);
    }
    written.set(artifact.nodeId, landed);
  }
  for (const write of plan.conversations) {
    await deps.createArtifact(write);
    done += 1;
    deps.onProgress?.(done, total);
  }
  return {
    projectId,
    artifacts: plan.artifacts.length,
    versions: total - plan.conversations.length,
    conversations: plan.conversations.length,
    written,
  };
}

function looksLikeZip(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

function isJsonEntry(path: string): boolean {
  if (path.includes("__MACOSX/")) return false;
  const base = path.split("/").pop() ?? path;
  if (base.startsWith(".")) return false;
  return base.toLowerCase().endsWith(".json");
}

/**
 * The JSON object inside a zip export: exactly one `.json` file, which is
 * the same `assembleBundle` payload a `.json` download carries. Other files
 * (a README, say) are ignored; more than one JSON is an error, not a guess.
 */
export async function jsonFromZip(bytes: Uint8Array, sourceName: string): Promise<unknown> {
  const zip = await JSZip.loadAsync(bytes);
  const jsonFiles = Object.values(zip.files).filter((entry) => !entry.dir && isJsonEntry(entry.name));
  if (jsonFiles.length === 0) {
    throw new Error(`${sourceName} has no JSON bundle inside.`);
  }
  if (jsonFiles.length > 1) {
    throw new Error(`${sourceName} has more than one JSON file; import needs exactly one.`);
  }
  return JSON.parse(await jsonFiles[0]!.async("string"));
}

/**
 * Reads a Home import file as the unknown payload `api.importProject` /
 * `parseBundle` already accept. A `.zip` is unpacked in the browser; a
 * `.json` is parsed as text. The bundle format itself is unchanged.
 */
export async function readImportPayload(file: File): Promise<unknown> {
  if (looksLikeZip(file)) {
    return jsonFromZip(new Uint8Array(await file.arrayBuffer()), file.name);
  }
  return JSON.parse(await file.text());
}

