/**
 * Importing a project bundle `project-export.ts`'s `assembleBundle` wrote
 * (CL-8725). The bundle's process history is never replayed: every artifact
 * and conversation is recreated fresh under a NEW project id, and that
 * project's own workflow starts at stage 1 like any other new project.
 * Approvals are for the person to make again.
 *
 * Mail history cannot be recreated (there is no mailbox to write into before
 * a stage specialist deploys), so each bundled conversation becomes one
 * read-only text artifact instead, `sb.kind: "imported_conversation"`.
 */
import JSZip from "jszip";
import type { ProjectBundle } from "./project-export.ts";

export const IMPORTED_CONVERSATION_KIND = "imported_conversation";

export type ImportWrite = {
  readonly title: string;
  readonly content: string;
  readonly sb: Record<string, unknown>;
};

export type ImportPlan = {
  readonly artifacts: readonly ImportWrite[];
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
 * network, nothing minted here. Every artifact becomes its own fresh
 * version-1 write -- `sourceVersionIds` reset to none -- with
 * `kind`/`stage`/`variant`/`mediaType`/`provenance` carried over from the
 * bundled node, re-keyed to `newProjectId`. Content, including a `data:` URL
 * for a binary original, is kept exactly as bundled.
 */
export function importPlan(bundle: ProjectBundle, newProjectId: string): ImportPlan {
  const artifacts: ImportWrite[] = bundle.artifacts.map(({ node, content }) => ({
    title: node.title,
    content,
    sb: {
      projectId: newProjectId,
      kind: node.kind,
      stage: node.stage,
      variant: node.variant,
      sourceVersionIds: [],
      provenance: { ...node.provenance },
      ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
    },
  }));

  return { artifacts, conversations: bundle.conversations.map((conversation) => conversationWrite(conversation, newProjectId)) };
}

/** The transcript artifact one bundled conversation becomes under `newProjectId`. */
export function conversationWrite({ stage, messages }: ProjectBundle["conversations"][number], newProjectId: string): ImportWrite {
  return {
    title: `Stage ${stage} conversation (imported)`,
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
  readonly createArtifact: (write: ImportWrite) => Promise<{ id: string }>;
  /** Called after each write, `done` counting both artifacts and conversations together. */
  readonly onProgress?: (done: number, total: number) => void;
};

export type ImportResult = {
  readonly projectId: string;
  readonly artifacts: number;
  readonly conversations: number;
};

/**
 * Creates the new project, then writes `importPlan`'s artifacts and
 * conversations into it one at a time -- an artifact-store write has no
 * batch form here, the same as `attachMaterial`.
 */
export async function importProject(bundle: ProjectBundle, deps: ImportDeps): Promise<ImportResult> {
  const { projectId } = await deps.createProject({ title: importedProjectTitle(bundle), policy: bundle.project.policy });
  const plan = importPlan(bundle, projectId);
  const writes = [...plan.artifacts, ...plan.conversations];
  let done = 0;
  for (const write of writes) {
    await deps.createArtifact(write);
    done += 1;
    deps.onProgress?.(done, writes.length);
  }
  return { projectId, artifacts: plan.artifacts.length, conversations: plan.conversations.length };
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

