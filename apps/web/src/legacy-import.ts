/**
 * Importing a project bundle `main` exported: format
 * `solutions-builder.project`, version 1. Where this app's own bundle
 * (`project-export.ts`, version 2) carries one content per artifact and
 * the mail of each stage, `main`'s carries the whole record: every version
 * of every artifact with its content, the lineage edges between versions,
 * each stage's conversation as turns, and the ledger the project's
 * position lived in.
 *
 * The import keeps all of it. Each lineage is recreated as one artifact with
 * the versions of every artifact in it written in order, so a lineage that
 * was several artifacts numbers its versions 1 to N, each version carrying the `sb` metadata the graph
 * reads (`legacy-adoption.ts`'s shape, re-keyed to the new project and to
 * the new artifact ids). Each conversation becomes the same read-only
 * transcript a version 2 import writes. The ledger is folded into an
 * adoption plan (`adoptionPlan`) naming the new artifacts, for
 * `adoption-replay.ts` to land on the new project's workflow once it runs.
 */
import { versionIdFor, type ArtifactGraphMetadata } from "@solutions-builder/app/artifact-graph";
import {
  adoptionPlan,
  legacyPosition,
  legacyProvenance,
  type AdoptedReference,
  type AdoptionPlan,
  type AdoptionStep,
  type LegacyCommand,
  type LegacyEdge,
  type LegacyNode,
} from "@solutions-builder/app/legacy-adoption";
import { BUNDLE_FORMAT } from "./project-export.ts";
import { conversationWrite, lineageOf, type ImportedVersions, type ImportWrite } from "./project-import.ts";
import { stageName } from "./stage-names.ts";

export const LEGACY_BUNDLE_VERSION = 1;

/** One artifact version as `main` exported it: the node row and its content. */
export type LegacyBundleNode = {
  readonly id: string;
  readonly artifactId: string;
  readonly version: number;
  readonly kind: string;
  readonly variant: string | null;
  readonly stage: number;
  readonly title: string;
  readonly mediaType: string;
  /** sha256 over the content as bundled (a `data:` URL for a binary original). */
  readonly contentHash: string;
  readonly provenance: Record<string, unknown> | null;
  readonly supersededByNodeId: string | null;
  readonly createdAt: string;
  readonly content: string;
};

/** One turn of a stage's conversation as `main` carried it. */
export type LegacyTurn = {
  readonly id: string;
  readonly role: "human" | "specialist";
  readonly body: string;
  readonly createdAt: string;
};

export type LegacyBundle = {
  readonly format: typeof BUNDLE_FORMAT;
  readonly version: typeof LEGACY_BUNDLE_VERSION;
  readonly exportedAt: string;
  readonly project: { readonly id: string; readonly title: string; readonly policy: unknown };
  readonly ledger: readonly { readonly startedAt: string; readonly metadata: LegacyCommand }[];
  readonly artifacts: { readonly nodes: readonly LegacyBundleNode[]; readonly edges: readonly LegacyEdge[] };
  readonly conversations: readonly { readonly stage: number; readonly turns: readonly LegacyTurn[] }[];
};

/** Whether `value` claims to be a version 1 bundle at all; `parseLegacyBundle` then checks it holds together. */
export function isLegacyBundle(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).format === BUNDLE_FORMAT && (value as Record<string, unknown>).version === LEGACY_BUNDLE_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNode(value: unknown, index: number): LegacyBundleNode {
  if (!isRecord(value)) throw new Error(`project bundle's artifact node ${String(index)} is not an object`);
  for (const key of ["id", "artifactId", "kind", "title", "mediaType", "contentHash", "createdAt", "content"] as const) {
    if (typeof value[key] !== "string") throw new Error(`project bundle's artifact node ${String(index)} is missing ${key}`);
  }
  if (typeof value.version !== "number" || typeof value.stage !== "number") {
    throw new Error(`project bundle's artifact node ${String(index)} is missing version or stage`);
  }
  return {
    id: value.id as string,
    artifactId: value.artifactId as string,
    version: value.version,
    kind: value.kind as string,
    variant: typeof value.variant === "string" ? value.variant : null,
    stage: value.stage,
    title: value.title as string,
    mediaType: value.mediaType as string,
    contentHash: value.contentHash as string,
    provenance: isRecord(value.provenance) ? value.provenance : null,
    supersededByNodeId: typeof value.supersededByNodeId === "string" ? value.supersededByNodeId : null,
    createdAt: value.createdAt as string,
    content: value.content as string,
  };
}

function parseTurn(value: unknown, stage: number, index: number): LegacyTurn {
  if (!isRecord(value) || typeof value.body !== "string" || typeof value.id !== "string") {
    throw new Error(`project bundle's stage ${String(stage)} conversation turn ${String(index)} is missing id or body`);
  }
  return {
    id: value.id,
    role: value.role === "human" ? "human" : "specialist",
    body: value.body,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  };
}

/** Validates an unknown value as a version 1 bundle, naming what is wrong the way `parseBundle` does. */
export function parseLegacyBundle(value: unknown): LegacyBundle {
  if (!isRecord(value)) throw new Error("not a project bundle: expected an object");
  if (value.format !== BUNDLE_FORMAT) {
    throw new Error(`not a project bundle: expected format "${BUNDLE_FORMAT}", got ${JSON.stringify(value.format)}`);
  }
  if (value.version !== LEGACY_BUNDLE_VERSION) throw new Error(`unsupported project bundle version: ${JSON.stringify(value.version)}`);
  if (typeof value.exportedAt !== "string") throw new Error("project bundle is missing exportedAt");
  if (!isRecord(value.project)) throw new Error("project bundle is missing project");
  const project = value.project;
  if (typeof project.id !== "string" || typeof project.title !== "string") throw new Error("project bundle's project is missing id or title");
  if (!("policy" in project)) throw new Error("project bundle's project is missing policy");
  if (!Array.isArray(value.ledger)) throw new Error("project bundle is missing ledger");
  if (!isRecord(value.artifacts) || !Array.isArray(value.artifacts.nodes) || !Array.isArray(value.artifacts.edges)) {
    throw new Error("project bundle is missing artifacts.nodes or artifacts.edges");
  }
  const ledger = value.ledger.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.metadata) || typeof entry.metadata.command !== "string") {
      throw new Error(`project bundle's ledger entry ${String(index)} is missing its command`);
    }
    return { startedAt: typeof entry.startedAt === "string" ? entry.startedAt : "", metadata: entry.metadata as unknown as LegacyCommand };
  });
  const nodes = value.artifacts.nodes.map(parseNode);
  const edges = value.artifacts.edges.map((edge, index) => {
    if (!isRecord(edge) || typeof edge.childNodeId !== "string" || typeof edge.sourceNodeId !== "string") {
      throw new Error(`project bundle's artifact edge ${String(index)} is missing childNodeId or sourceNodeId`);
    }
    return { childNodeId: edge.childNodeId, sourceNodeId: edge.sourceNodeId };
  });
  const conversations = (Array.isArray(value.conversations) ? value.conversations : []).map((conversation, index) => {
    if (!isRecord(conversation) || typeof conversation.stage !== "number" || !Array.isArray(conversation.turns)) {
      throw new Error(`project bundle's conversation ${String(index)} is missing stage or turns`);
    }
    const stage = conversation.stage;
    return { stage, turns: conversation.turns.map((turn, at) => parseTurn(turn, stage, at)) };
  });
  return {
    format: BUNDLE_FORMAT,
    version: LEGACY_BUNDLE_VERSION,
    exportedAt: value.exportedAt,
    project: { id: project.id, title: project.title, policy: project.policy },
    ledger,
    artifacts: { nodes, edges },
    conversations,
  };
}

/** A version of one of the bundle's artifacts, by `main`'s artifact id and version number. */
export type LegacyVersionKey = { readonly artifactKey: string; readonly version: number };

/**
 * One version write, in the order the writes happen. The first write of an
 * `artifactKey`, a lineage, creates the artifact; each later one revises it,
 * and the store numbers them 1, 2, 3…. `from` is the version `main` had, and
 * `sources` name other bundled versions the same way, for the importer to
 * translate once those versions exist here.
 */
export type LegacyVersionWrite = LegacyVersionKey & {
  readonly from: LegacyVersionKey;
  readonly title: string;
  readonly content: string;
  readonly sb: Omit<ArtifactGraphMetadata, "sourceVersionIds" | "supersedes">;
  readonly sources: readonly LegacyVersionKey[];
};

export type LegacyImportPlan = {
  readonly versions: readonly LegacyVersionWrite[];
  readonly conversations: readonly ImportWrite[];
};

/** `<original title> (imported)`, the new project's title, as for a version 2 bundle. */
export function importedLegacyTitle(bundle: LegacyBundle): string {
  return `${bundle.project.title} (imported)`;
}

/**
 * The pure write plan for one bundle under a freshly created project id.
 * Versions are written oldest first across every artifact, so a draft's
 * sources exist before it does; within one artifact that is also version
 * order. An artifact whose versions skip a number is refused here rather
 * than numbered wrong.
 */
export function legacyImportPlan(bundle: LegacyBundle, newProjectId: string): LegacyImportPlan {
  const nodes = [...bundle.artifacts.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sourcesOf = new Map<string, LegacyVersionKey[]>();
  for (const edge of bundle.artifacts.edges) {
    const source = byId.get(edge.sourceNodeId);
    if (!source) continue;
    const list = sourcesOf.get(edge.childNodeId) ?? [];
    list.push({ artifactKey: source.artifactId, version: source.version });
    sourcesOf.set(edge.childNodeId, list);
  }
  // The old rows pointed from the replaced artifact to its successor; a
  // successor in another artifact continues the same lineage.
  const supersedes = new Map<string, string>();
  for (const node of nodes) {
    const successor = node.supersededByNodeId ? byId.get(node.supersededByNodeId) : undefined;
    if (successor && successor.artifactId !== node.artifactId) supersedes.set(successor.artifactId, node.artifactId);
  }
  const written = new Map<string, number>();
  const numbered = new Map<string, number>();
  const versions: LegacyVersionWrite[] = nodes.map((node) => {
    const expected = (written.get(node.artifactId) ?? 0) + 1;
    if (node.version !== expected) {
      throw new Error(`project bundle's artifact ${node.artifactId} has version ${String(node.version)} where version ${String(expected)} was expected`);
    }
    written.set(node.artifactId, expected);
    const artifactKey = lineageOf({ ...node, id: node.artifactId }, supersedes);
    const version = (numbered.get(artifactKey) ?? 0) + 1;
    numbered.set(artifactKey, version);
    return {
      artifactKey,
      version,
      from: { artifactKey: node.artifactId, version: node.version },
      title: node.title,
      content: node.content,
      sb: {
        projectId: newProjectId,
        kind: node.kind,
        stage: node.stage,
        ...(node.variant ? { variant: node.variant } : {}),
        provenance: legacyProvenance(node.provenance),
        mediaType: node.mediaType,
      },
      sources: sourcesOf.get(node.id) ?? [],
    };
  });
  const conversations = bundle.conversations
    .filter((conversation) => conversation.turns.length > 0)
    .map((conversation) =>
      conversationWrite(
        {
          stage: conversation.stage,
          messages: conversation.turns.map((turn) => ({ id: turn.id, author: turn.role === "human" ? "me" : "agent", body: turn.body, at: turn.createdAt })),
        },
        newProjectId,
      ),
    );
  return { versions, conversations };
}

function legacyPolicy(policy: unknown): { audiences: { name: string }[]; audienceQuorum: number } {
  const record = isRecord(policy) ? policy : {};
  const audiences = Array.isArray(record.audiences)
    ? record.audiences.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.name === "string").map((entry) => ({ name: entry.name as string }))
    : [];
  return { audiences, audienceQuorum: typeof record.audienceQuorum === "number" ? record.audienceQuorum : 0 };
}

/**
 * The adoption plan for the imported project: the old ledger folded to its
 * position, each stage's approval re-pointed at the version written here
 * for the one it named. The digest is unchanged, since it is over the same
 * content. An approval naming an artifact the bundle does not
 * carry ends the replay before that stage, and the plan's notes say so.
 */
export function legacyAdoptionPlan(bundle: LegacyBundle, newProjectId: string, ids: ImportedVersions): AdoptionPlan {
  const nodes: LegacyNode[] = bundle.artifacts.nodes.map((node) => ({
    id: node.id,
    projectId: newProjectId,
    artifactId: node.artifactId,
    version: node.version,
    kind: node.kind,
    stage: node.stage,
    variant: node.variant,
    mediaType: node.mediaType,
    provenance: node.provenance,
    supersededByNodeId: node.supersededByNodeId,
  }));
  const contents = new Map(bundle.artifacts.nodes.map((node) => [versionIdFor(node.artifactId, node.version), node.content]));
  const plan = adoptionPlan({
    projectId: newProjectId,
    position: legacyPosition(bundle.ledger.map((entry) => entry.metadata)),
    nodes,
    policy: legacyPolicy(bundle.project.policy),
    readContent: (artifactId, version) => contents.get(versionIdFor(artifactId, version)) ?? null,
  });
  const steps: AdoptionStep[] = [];
  const notes = [...plan.notes];
  const repoint = (ref: AdoptedReference): AdoptedReference | null => {
    const written = ids.get(versionIdFor(ref.artifactId, ref.version));
    return written ? { ...written, sha256: ref.sha256 } : null;
  };
  for (const step of plan.steps) {
    const ref = repoint(step.ref);
    if (!ref) {
      notes.push(`The ${stageName(step.stage)} approval names an artifact the bundle does not carry; replay stops before it.`);
      break;
    }
    const packages = step.packages
      ? Object.fromEntries(Object.entries(step.packages).flatMap(([audience, reviewed]) => {
          const written = repoint(reviewed);
          return written ? [[audience, written]] : [];
        }))
      : undefined;
    steps.push({ ...step, ref, ...(packages ? { packages } : {}) });
  }
  return { ...plan, steps, notes };
}

export type LegacyImportDeps = {
  readonly createProject: (input: { title: string; policy: unknown }) => Promise<{ projectId: string }>;
  /** Creates an artifact at version 1. */
  readonly createArtifact: (write: ImportWrite) => Promise<{ id: string; version: number }>;
  /** Writes the next version of an artifact, returning the number the store gave it. */
  readonly reviseArtifact: (artifactId: string, write: ImportWrite) => Promise<{ version: number }>;
  /** Called after each write, `done` counting versions and conversations together. */
  readonly onProgress?: (done: number, total: number) => void;
};

export type LegacyImportResult = {
  readonly projectId: string;
  /** Distinct artifacts written, and versions across all of them. */
  readonly artifacts: number;
  readonly versions: number;
  readonly conversations: number;
  /** The replay that lands the project where `main` left it, for `replayAdoption` once the workflow runs. */
  readonly plan: AdoptionPlan;
};

/**
 * Creates the new project and writes `legacyImportPlan`'s versions and
 * conversations into it, one write at a time, translating each version's
 * sources to the versions written before it. A store that numbers a version
 * other than the plan's is an error, not a silent mismatch: the replayed
 * approvals name those numbers.
 */
export async function importLegacyProject(bundle: LegacyBundle, deps: LegacyImportDeps): Promise<LegacyImportResult> {
  const { projectId } = await deps.createProject({ title: importedLegacyTitle(bundle), policy: bundle.project.policy });
  const plan = legacyImportPlan(bundle, projectId);
  const total = plan.versions.length + plan.conversations.length;
  const ids = new Map<string, string>();
  const versions = new Map<string, { artifactId: string; version: number }>();
  let done = 0;
  for (const write of plan.versions) {
    const sourceVersionIds = write.sources.flatMap((source) => {
      const written = versions.get(versionIdFor(source.artifactKey, source.version));
      return written ? [versionIdFor(written.artifactId, written.version)] : [];
    });
    const sb: ArtifactGraphMetadata = { ...write.sb, sourceVersionIds };
    const existing = ids.get(write.artifactKey);
    let version: number;
    if (existing) {
      ({ version } = await deps.reviseArtifact(existing, { title: write.title, content: write.content, sb }));
    } else {
      const created = await deps.createArtifact({ title: write.title, content: write.content, sb });
      ids.set(write.artifactKey, created.id);
      version = created.version;
    }
    if (version !== write.version) {
      throw new Error(`the artifact store numbered "${write.title}" version ${String(write.version)} as ${String(version)}`);
    }
    versions.set(versionIdFor(write.from.artifactKey, write.from.version), { artifactId: ids.get(write.artifactKey)!, version });
    done += 1;
    deps.onProgress?.(done, total);
  }
  for (const write of plan.conversations) {
    await deps.createArtifact(write);
    done += 1;
    deps.onProgress?.(done, total);
  }
  return {
    projectId,
    artifacts: ids.size,
    versions: plan.versions.length,
    conversations: plan.conversations.length,
    plan: legacyAdoptionPlan(bundle, projectId, versions),
  };
}
