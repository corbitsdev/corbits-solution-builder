/**
 * Importing a project `project-export.ts` exported (CL-8725) as a NEW
 * project. Every artifact is recreated with its versions written in order,
 * oldest artifact first, so each keeps its own version number and its place
 * in its lineage; build archives are artifacts too, so earlier attempts come
 * along. The approvals the workflow had recorded are folded into an adoption
 * plan (`adoption-replay.ts` lands it once the new project's workflow runs).
 *
 * Mail history cannot be recreated (there is no mailbox to write into before
 * a stage specialist deploys), so each bundled conversation becomes one
 * read-only text artifact instead, `sb.kind: "imported_conversation"`.
 */
import JSZip from "jszip";
import { LAST_ADOPTED_STAGE, type AdoptedReference, type AdoptionPlan, type AdoptionStep, type AudienceVote } from "@solutions-builder/app/legacy-adoption";
import { toBase64 } from "./base64.ts";
import { ARCHIVE_STATE_FILE, type ExportedWorkflow, type ProjectBundle } from "./project-export.ts";
import { stageName } from "./stage-names.ts";

export const IMPORTED_CONVERSATION_KIND = "imported_conversation";

export type ImportWrite = {
  readonly title: string;
  readonly content: string;
  readonly sb: Record<string, unknown>;
};

/** One bundled artifact: its versions in order, and the bundled artifact it supersedes. */
export type ArtifactImport = {
  readonly key: string;
  readonly supersedes: string | null;
  readonly versions: readonly { readonly version: number; readonly write: ImportWrite }[];
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
 * network, nothing minted here. Artifacts come oldest first, since a
 * version's place in its lineage is read off when it was written; each
 * carries `kind`/`stage`/`variant`/`mediaType`/`provenance` from the bundled
 * node, re-keyed to `newProjectId`, with `sourceVersionIds` reset to none.
 * Content, including a `data:` URL for a binary original, is kept exactly.
 */
export function importPlan(bundle: ProjectBundle, newProjectId: string): ImportPlan {
  const supersedes = new Map<string, string>();
  for (const { node } of bundle.artifacts) {
    if (node.supersededByNodeId) supersedes.set(node.supersededByNodeId, node.id);
  }
  const artifacts = [...bundle.artifacts]
    .sort((a, b) => Date.parse(a.node.createdAt) - Date.parse(b.node.createdAt))
    .map(({ node, versions }): ArtifactImport => ({
      key: node.id,
      supersedes: supersedes.get(node.id) ?? null,
      versions: [...versions]
        .sort((a, b) => a.version - b.version)
        .map(({ version, content }) => ({
          version,
          write: {
            title: node.title,
            content,
            sb: {
              projectId: newProjectId,
              kind: node.kind,
              stage: node.stage,
              ...(node.variant ? { variant: node.variant } : {}),
              sourceVersionIds: [],
              provenance: { ...node.provenance },
              ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
            },
          },
        })),
    }));

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

/**
 * The approvals the exported workflow recorded, as a replay on the new
 * project: each stage's approved review re-pointed at the artifact written
 * here, version and digest unchanged since the versions were written in
 * order with the same content. Stage 5 carries its policy, votes and
 * packages; stage 6 its requirement items; stage 3 its surface, whose
 * skipped stages are not replayed. It stops where the record does,
 * and at `LAST_ADOPTED_STAGE`, as the legacy import's replay does.
 */
export function workflowAdoptionPlan(workflow: ExportedWorkflow | null, newProjectId: string, ids: ReadonlyMap<string, string>): AdoptionPlan {
  const plan = { projectId: newProjectId, legacyStage: workflow?.stage ?? 1, legacyDone: workflow?.done ?? false };
  if (!workflow) return { ...plan, steps: [], notes: [] };
  const notes: string[] = [];
  const steps: AdoptionStep[] = [];
  const repoint = (ref: AdoptedReference): AdoptedReference | null => {
    const artifactId = ids.get(ref.artifactId);
    return artifactId ? { artifactId, version: ref.version, sha256: ref.sha256 } : null;
  };
  const reached = workflow.done ? Infinity : workflow.stage;
  if (reached > LAST_ADOPTED_STAGE + 1) {
    notes.push(`Approvals are replayed no further than ${stageName(LAST_ADOPTED_STAGE)}; ${stageName(LAST_ADOPTED_STAGE + 1)} and later are yours to approve again here.`);
  }
  for (let stage = 1; stage < Math.min(reached, LAST_ADOPTED_STAGE + 1); stage += 1) {
    if (workflow.skipped.includes(stage)) continue;
    const review = workflow.reviews[stage];
    if (review?.status !== "approved") break;
    const ref = repoint(review);
    if (!ref) {
      notes.push(`The ${stageName(stage)} approval names an artifact the export does not carry; replay stops before it.`);
      break;
    }
    if (stage === 5) {
      const packages: Record<string, AdoptedReference> = {};
      const votes: Record<string, AudienceVote> = {};
      for (const [audience, vote] of Object.entries(workflow.audienceDecisions)) {
        const reviewed = workflow.audiencePackages[audience] ? repoint(workflow.audiencePackages[audience]) : null;
        if (!reviewed) {
          notes.push(`${audience}'s vote names no package the export carries, so it is not replayed; they decide again here.`);
          continue;
        }
        packages[audience] = reviewed;
        votes[audience] = { decision: vote.decision, note: vote.note };
      }
      steps.push({ stage, ref, ...(workflow.audiencePolicy ? { policy: workflow.audiencePolicy } : {}), votes, packages });
      continue;
    }
    if (stage === 6) {
      steps.push({ stage, ref, requirementItems: workflow.requirements.map(({ kind, text }) => ({ kind, text })) });
      continue;
    }
    steps.push({ stage, ref, ...(stage === 3 && workflow.surface ? { surface: workflow.surface } : {}) });
  }
  return { ...plan, steps, notes };
}

export type ImportDeps = {
  readonly createProject: (input: { title: string; policy: unknown }) => Promise<{ projectId: string }>;
  /** Creates an artifact at version 1. */
  readonly createArtifact: (write: ImportWrite) => Promise<{ id: string; version: number }>;
  /** Writes the next version of an artifact, returning the number the store gave it. */
  readonly reviseArtifact: (artifactId: string, write: ImportWrite) => Promise<{ version: number }>;
  /** Called after each write, `done` counting versions and conversations together. */
  readonly onProgress?: (done: number, total: number) => void;
};

export type ImportResult = {
  readonly projectId: string;
  readonly artifacts: number;
  readonly versions: number;
  readonly conversations: number;
  /** The approvals to replay once the new project's workflow runs. */
  readonly plan: AdoptionPlan;
};

/**
 * Creates the new project, then writes `importPlan`'s versions and
 * conversations into it one at a time -- an artifact-store write has no
 * batch form here, the same as `attachMaterial`. A store that numbers a
 * version differently from the export is an error, not a silent mismatch:
 * the recorded approvals name those numbers.
 */
export async function importProject(bundle: ProjectBundle, deps: ImportDeps): Promise<ImportResult> {
  const { projectId } = await deps.createProject({ title: importedProjectTitle(bundle), policy: bundle.project.policy });
  const plan = importPlan(bundle, projectId);
  const versions = plan.artifacts.reduce((total, artifact) => total + artifact.versions.length, 0);
  const total = versions + plan.conversations.length;
  const ids = new Map<string, string>();
  let done = 0;
  const step = () => {
    done += 1;
    deps.onProgress?.(done, total);
  };
  for (const artifact of plan.artifacts) {
    const superseded = artifact.supersedes ? ids.get(artifact.supersedes) : undefined;
    let id: string | undefined;
    for (const { version: expected, write } of artifact.versions) {
      const sb = { ...write.sb, ...(superseded ? { supersedes: superseded } : {}) };
      let version: number;
      if (id) {
        ({ version } = await deps.reviseArtifact(id, { ...write, sb }));
      } else {
        const created = await deps.createArtifact({ ...write, sb });
        id = created.id;
        version = created.version;
      }
      if (version !== expected) throw new Error(`the artifact store numbered "${write.title}" version ${String(expected)} as ${String(version)}`);
      step();
    }
    if (id) ids.set(artifact.key, id);
  }
  for (const write of plan.conversations) {
    await deps.createArtifact(write);
    step();
  }
  return {
    projectId,
    artifacts: ids.size,
    versions,
    conversations: plan.conversations.length,
    plan: workflowAdoptionPlan(bundle.workflow, projectId, ids),
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
 * not a guess.
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
