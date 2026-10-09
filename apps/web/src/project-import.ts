/**
 * Importing a project bundle `project-export.ts`'s `assembleBundle` wrote
 * (CL-8725). Every artifact and conversation is recreated fresh under a NEW
 * project id, an artifact's versions written back in the order the export
 * carried them (#632). The workflow's position is landed afterwards by
 * `bundle-adoption.ts`, as real decisions on the new project's own workflow
 * (#652); nothing here writes a decision.
 *
 * Mail history cannot be recreated (there is no mailbox to write into before
 * a stage specialist deploys), so each bundled conversation becomes one
 * read-only text artifact instead, `sb.kind: "imported_conversation"`.
 */
import JSZip from "jszip";
import { stageName } from "./components.jsx";
import type { ProjectBundle } from "./project-export.ts";

export const IMPORTED_CONVERSATION_KIND = "imported_conversation";

export type ImportWrite = {
  readonly title: string;
  readonly content: string;
  readonly sb: Record<string, unknown>;
};

/** One bundled node's writes, oldest version first: the first creates the artifact, each later one revises it. */
export type ArtifactImport = {
  readonly nodeId: string;
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
 * The pure write plan for one bundle under a freshly created project id: no
 * network, nothing minted here. Every artifact becomes a fresh one --
 * `sourceVersionIds` reset to none -- with
 * `kind`/`stage`/`variant`/`mediaType`/`provenance` carried over from the
 * bundled node, re-keyed to `newProjectId`, and one write per bundled
 * version, oldest first; a v2 or v3 bundle carried only the current content,
 * so it is one write. Content, including a `data:` URL for a binary
 * original, is kept exactly as bundled.
 */
export function importPlan(bundle: ProjectBundle, newProjectId: string): ImportPlan {
  const artifacts: ArtifactImport[] = bundle.artifacts.map(({ node, content, versions }) => {
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
    return { nodeId: node.id, versions: chain.map((text) => ({ title: node.title, content: text, sb })) };
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
    const created = await deps.createArtifact(first);
    let landed: WrittenArtifact = { artifactId: created.id, version: created.version };
    done += 1;
    deps.onProgress?.(done, total);
    for (const write of later) {
      const revised = await deps.reviseArtifact(created.id, write);
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

