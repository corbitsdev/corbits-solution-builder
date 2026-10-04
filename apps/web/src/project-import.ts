/**
 * Importing a project `project-export.ts` exported (CL-8725).
 *
 * v2/v3 JSON: one create per artifact, then `bundleAdoptionPlan` /
 * `replayAdoption` lands the workflow (#652). v4 zip: every version is
 * written in order (create, then revise), gzip as real bytes, and a zip
 * planner feeds the same replay. Mail history cannot be recreated, so each
 * bundled conversation becomes one read-only text artifact,
 * `sb.kind: "imported_conversation"`.
 */
import JSZip from "jszip";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { LAST_ADOPTED_STAGE, type AdoptedReference, type AdoptionPlan, type AdoptionStep, type AudienceVote } from "@solutions-builder/app/legacy-adoption";
import { toBase64 } from "./base64.ts";
import { stageName } from "./components.jsx";
import {
  ARCHIVE_STATE_FILE,
  type ArchiveBundle,
  type ExportedWorkflow,
  type ProjectBundle,
} from "./project-export.ts";

export const IMPORTED_CONVERSATION_KIND = "imported_conversation";

export type ImportWrite = {
  readonly title: string;
  readonly content: string;
  readonly sb: Record<string, unknown>;
};

/** One bundled artifact to write: its id there, the one it superseded, and its versions in order. */
export type ArtifactImport = {
  readonly from: string;
  readonly artifactId: string;
  readonly supersedes: string | null;
  readonly versions: readonly ImportWrite[];
};

/** Where each bundled version (`versionIdFor`) was written here. */
export type ImportedVersions = ReadonlyMap<string, { readonly artifactId: string; readonly version: number }>;

export type ArchiveImportPlan = {
  readonly artifacts: readonly ArtifactImport[];
  readonly conversations: readonly ImportWrite[];
};

export type JsonImportPlan = {
  readonly artifacts: readonly ImportWrite[];
  readonly conversations: readonly ImportWrite[];
};

/** `<original title> (imported)`, the new project's title. */
export function importedProjectTitle(bundle: { project: { title: string } }): string {
  return `${bundle.project.title} (imported)`;
}

/** One stage's messages as the read-only text an `imported_conversation` artifact holds. */
export function transcript(messages: { author: string; at: string; body: string }[]): string {
  return messages
    .map((message) => `**${message.author === "me" ? "You" : "Specialist"}** — ${message.at}\n\n${message.body}`)
    .join("\n\n---\n\n");
}

export function conversationWrite(conversation: { stage: number; messages: { author: string; at: string; body: string }[] }, newProjectId: string): ImportWrite {
  return {
    title: `${stageName(conversation.stage)} conversation (imported)`,
    content: transcript(conversation.messages),
    sb: {
      projectId: newProjectId,
      kind: IMPORTED_CONVERSATION_KIND,
      stage: conversation.stage,
      variant: null,
      sourceVersionIds: [],
      provenance: { producer: "human" as const },
      mediaType: "text/markdown",
    },
  };
}

function artifactSb(node: ArchiveBundle["artifacts"][number]["node"] | ProjectBundle["artifacts"][number]["node"], newProjectId: string): Record<string, unknown> {
  return {
    projectId: newProjectId,
    kind: node.kind,
    stage: node.stage,
    variant: node.variant,
    sourceVersionIds: [],
    provenance: { ...node.provenance },
    ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
  };
}

/**
 * The pure write plan for a v4 zip under a freshly created project id.
 * Artifacts come oldest first, so the one an artifact supersedes is written
 * before it; each version carries kind/stage/variant/mediaType/provenance
 * from the bundled node, re-keyed to `newProjectId`.
 */
export function archiveImportPlan(bundle: ArchiveBundle, newProjectId: string): ArchiveImportPlan {
  const supersedes = new Map<string, string>();
  for (const { node } of bundle.artifacts) {
    if (node.supersededByNodeId) supersedes.set(node.supersededByNodeId, node.id);
  }
  const artifacts = [...bundle.artifacts]
    .sort((a, b) => Date.parse(a.node.createdAt) - Date.parse(b.node.createdAt))
    .map(({ node, versions }): ArtifactImport => ({
      from: node.id,
      artifactId: node.artifactId,
      supersedes: supersedes.get(node.id) ?? null,
      versions: [...versions]
        .sort((a, b) => a.version - b.version)
        .map(({ content }) => ({
          title: node.title,
          content,
          sb: artifactSb(node, newProjectId),
        })),
    }));

  return { artifacts, conversations: bundle.conversations.map((conversation) => conversationWrite(conversation, newProjectId)) };
}

/** @deprecated alias kept for zip-era tests; use `archiveImportPlan`. */
export const importPlan = archiveImportPlan;

/**
 * The pure write plan for a v2/v3 JSON bundle: one fresh version-1 write
 * per artifact, the same as #653.
 */
export function jsonImportPlan(bundle: ProjectBundle, newProjectId: string): JsonImportPlan {
  const artifacts: ImportWrite[] = bundle.artifacts.map(({ node, content }) => ({
    title: node.title,
    content,
    sb: artifactSb(node, newProjectId),
  }));
  return { artifacts, conversations: bundle.conversations.map((conversation) => conversationWrite(conversation, newProjectId)) };
}

/**
 * The approvals the exported v4 workflow recorded, as a replay on the new
 * project: each stage's approved review re-pointed at the version written
 * here. It stops where the record does, and at `LAST_ADOPTED_STAGE`.
 */
export function workflowAdoptionPlan(workflow: ExportedWorkflow | null, newProjectId: string, ids: ImportedVersions): AdoptionPlan {
  const plan = { projectId: newProjectId, legacyStage: workflow?.stage ?? 1, legacyDone: workflow?.done ?? false };
  if (!workflow) return { ...plan, steps: [], notes: [] };
  const notes: string[] = [];
  const steps: AdoptionStep[] = [];
  const repoint = (ref: AdoptedReference): AdoptedReference | null => {
    const written = ids.get(versionIdFor(ref.artifactId, ref.version));
    return written ? { ...written, sha256: ref.sha256 } : null;
  };
  const reached = workflow.done ? Infinity : workflow.stage;
  if (reached > LAST_ADOPTED_STAGE + 1) {
    notes.push(`Approvals are replayed no further than ${stageName(LAST_ADOPTED_STAGE)}; ${stageName(LAST_ADOPTED_STAGE + 1)} and later are yours to approve again here.`);
  }
  for (let stage = 1; stage < Math.min(reached, LAST_ADOPTED_STAGE + 1); stage += 1) {
    const review = workflow.reviews[stage];
    if (review?.status !== "approved") break;
    const ref = repoint({ artifactId: review.artifactId, version: review.version, sha256: review.sha256 });
    if (!ref) {
      notes.push(`${stageName(stage)}'s approval names an artifact the export does not carry; replay stops before it.`);
      break;
    }
    if (stage === 5) {
      const packages: Record<string, AdoptedReference> = {};
      const votes: Record<string, AudienceVote> = {};
      for (const [audience, vote] of Object.entries(workflow.votes)) {
        const reviewed = workflow.audiencePackages[audience]
          ? repoint({
              artifactId: workflow.audiencePackages[audience]!.artifactId,
              version: workflow.audiencePackages[audience]!.version,
              sha256: workflow.audiencePackages[audience]!.sha256,
            })
          : null;
        if (!reviewed) {
          notes.push(`${audience}'s vote names no package the export carries, so it is not replayed; they decide again here.`);
          continue;
        }
        packages[audience] = reviewed;
        votes[audience] = { decision: vote.decision, note: vote.note ?? "" };
      }
      steps.push({ stage, ref, ...(workflow.audiencePolicy ? { policy: workflow.audiencePolicy } : {}), votes, packages });
      continue;
    }
    if (stage === 6) {
      steps.push({ stage, ref, requirementItems: workflow.requirements.map(({ kind, text }) => ({ kind, text })) });
      continue;
    }
    steps.push({ stage, ref });
  }
  return { ...plan, steps, notes };
}

export type JsonImportDeps = {
  readonly createProject: (input: { title: string; policy: unknown }) => Promise<{ projectId: string }>;
  readonly createArtifact: (write: ImportWrite) => Promise<{ id: string }>;
  readonly onProgress?: (done: number, total: number) => void;
};

export type JsonImportResult = {
  readonly projectId: string;
  readonly artifacts: number;
  readonly conversations: number;
  readonly ids: ReadonlyMap<string, string>;
};

export type ArchiveImportDeps = {
  readonly createProject: (input: { title: string; policy: unknown }) => Promise<{ projectId: string }>;
  readonly createArtifact: (write: ImportWrite) => Promise<{ id: string; version: number }>;
  readonly reviseArtifact: (artifactId: string, write: ImportWrite) => Promise<{ version: number }>;
  readonly onProgress?: (done: number, total: number) => void;
};

export type ArchiveImportResult = {
  readonly projectId: string;
  readonly artifacts: number;
  readonly versions: number;
  readonly conversations: number;
  readonly plan: AdoptionPlan;
};

export type ImportDeps = ArchiveImportDeps;
export type ImportResult = ArchiveImportResult;

/** v2/v3 JSON: one create per bundled node, ids keyed by the node's id (#652). */
export async function importJsonProject(bundle: ProjectBundle, deps: JsonImportDeps): Promise<JsonImportResult> {
  const { projectId } = await deps.createProject({ title: importedProjectTitle(bundle), policy: bundle.project.policy });
  const plan = jsonImportPlan(bundle, projectId);
  const ids = new Map<string, string>();
  const total = plan.artifacts.length + plan.conversations.length;
  let done = 0;
  for (const [index, write] of plan.artifacts.entries()) {
    const written = await deps.createArtifact(write);
    ids.set(bundle.artifacts[index]!.node.id, written.id);
    done += 1;
    deps.onProgress?.(done, total);
  }
  for (const write of plan.conversations) {
    await deps.createArtifact(write);
    done += 1;
    deps.onProgress?.(done, total);
  }
  return { projectId, artifacts: plan.artifacts.length, conversations: plan.conversations.length, ids };
}

/**
 * v4 zip: creates the new project, then writes every version in order.
 * A store that numbers a version other than the source did is an error.
 */
export async function importArchive(bundle: ArchiveBundle, deps: ArchiveImportDeps): Promise<ArchiveImportResult> {
  const { projectId } = await deps.createProject({ title: importedProjectTitle(bundle), policy: bundle.project.policy });
  const plan = archiveImportPlan(bundle, projectId);
  const versions = plan.artifacts.reduce((total, artifact) => total + artifact.versions.length, 0);
  const total = versions + plan.conversations.length;
  const artifactIds = new Map<string, string>();
  const ids = new Map<string, { artifactId: string; version: number }>();
  let done = 0;
  const step = () => {
    done += 1;
    deps.onProgress?.(done, total);
  };
  for (const artifact of plan.artifacts) {
    const superseded = artifact.supersedes ? artifactIds.get(artifact.supersedes) : undefined;
    let id: string | undefined;
    for (const [index, write] of artifact.versions.entries()) {
      const sb = superseded ? { ...write.sb, supersedes: superseded } : write.sb;
      let version: number;
      if (id) ({ version } = await deps.reviseArtifact(id, { ...write, sb }));
      else ({ id, version } = await deps.createArtifact({ ...write, sb }));
      if (version !== index + 1) throw new Error(`the artifact store numbered "${write.title}" version ${String(index + 1)} as ${String(version)}`);
      ids.set(versionIdFor(artifact.from, version), { artifactId: id, version });
      ids.set(versionIdFor(artifact.artifactId, version), { artifactId: id, version });
      step();
    }
    if (id) artifactIds.set(artifact.from, id);
  }
  for (const write of plan.conversations) {
    await deps.createArtifact(write);
    step();
  }
  return {
    projectId,
    artifacts: plan.artifacts.length,
    versions,
    conversations: plan.conversations.length,
    plan: workflowAdoptionPlan(bundle.workflow, projectId, ids),
  };
}

/** Zip-era name: writes every version of a v4 archive. */
export const importProject = importArchive;

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
 * The bundle an export zip carries, its versions' content read back from
 * the files `project.json` names: a `data:` URL rebuilt from the bytes for a
 * binary original, the text as written for everything else.
 */
async function bundleFromArchive(zip: JSZip, sourceName: string): Promise<unknown> {
  const state: unknown = JSON.parse(await zip.file(ARCHIVE_STATE_FILE)!.async("string"));
  const artifacts = (state as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return state;
  const read = async (entry: { path?: unknown; dataUrlHeader?: unknown }): Promise<string | undefined> => {
    if (typeof entry.path !== "string") return undefined;
    const file = zip.file(entry.path);
    if (!file) throw new Error(`${sourceName} is missing ${entry.path}, which its ${ARCHIVE_STATE_FILE} names.`);
    return typeof entry.dataUrlHeader === "string" ? entry.dataUrlHeader + toBase64(await file.async("uint8array")) : file.async("string");
  };
  return {
    ...(state as object),
    artifacts: await Promise.all(
      artifacts.map(async (artifact: { versions?: unknown }) => ({
        ...artifact,
        versions: Array.isArray(artifact.versions)
          ? await Promise.all(artifact.versions.map(async (entry: Record<string, unknown>) => ({ ...entry, content: await read(entry) })))
          : artifact.versions,
      })),
    ),
  };
}

/**
 * The JSON object inside a zip: an export's `project.json` with its files,
 * else exactly one `.json` file, the JSON bundle an older export zipped up.
 * Other files (a README, say) are ignored; more than one JSON is an error,
 * not a guess. A v4 archive also has `builds/.../manifest.json`, so
 * `project.json` is preferred when present.
 */
export async function jsonFromZip(bytes: Uint8Array, sourceName: string): Promise<unknown> {
  const zip = await JSZip.loadAsync(bytes);
  if (zip.file(ARCHIVE_STATE_FILE)) return bundleFromArchive(zip, sourceName);
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
 * Reads a Home import file as the unknown payload `api.importProject`
 * accepts. A `.zip` is unpacked in the browser; a `.json` is parsed as text.
 */
export async function readImportPayload(file: File): Promise<unknown> {
  if (looksLikeZip(file)) {
    return jsonFromZip(new Uint8Array(await file.arrayBuffer()), file.name);
  }
  return JSON.parse(await file.text());
}
