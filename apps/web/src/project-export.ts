/**
 * A project exported as one JSON bundle, assembled entirely in the browser
 * from reads the client already has: the artifact graph with every version
 * of each artifact (#632), each deployed stage's mail thread, and the
 * project's own title and policy (CL-8702). `project-import.ts` reads it
 * back.
 */
import type { ArtifactNode } from "./client.ts";
import type { ChatMessage } from "./stage-mail.ts";

export const BUNDLE_FORMAT = "solutions-builder.project" as const;
/** v4 carries every version of each artifact (#632), v3 the workflow's position (#652); a v2 or v3 bundle is still read. */
export const BUNDLE_VERSION = 4 as const;
export const READABLE_BUNDLE_VERSIONS: readonly number[] = [2, 3, 4];
const STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** A node as recorded; its lineage position is derived when a project is read. */
export type ExportedNode = Omit<ArtifactNode, "position">;
/** One of an artifact's own versions, numbered as the store numbers it. */
export type ExportedVersion = { version: number; content: string };
/** `content` is the current version's. `versions` is every version the
 *  store could read, oldest first, the last being the current one; absent
 *  from a v2 or v3 bundle, which carried only the current content.
 *  `sources` names the bundled nodes this one was generated from (the
 *  graph's edges), so the import can link them again; absent from a bundle
 *  exported before it was carried. */
export type ExportedArtifact = { node: ExportedNode; content: string; versions?: ExportedVersion[]; sources?: string[] };
export type ExportedConversation = { stage: number; messages: ChatMessage[] };

/** The workflow's position as exported (#652): what the import replays so the new project lands where the old one was. */
export type BundleWorkflow = {
  readonly stage: number;
  readonly done: boolean;
  /** Accepted decisions, in order, with only the fields the replay reads. */
  readonly decisions: readonly {
    readonly kind: string;
    readonly stage: number;
    readonly artifactId?: string;
    readonly version?: number;
    readonly sha256?: string;
    readonly targetStage?: number;
    readonly target?: string;
  }[];
  /** Each stakeholder's latest Concept approval vote, by name. */
  readonly audienceDecisions: Readonly<Record<string, { readonly decision: "proceed" | "revise" | "reject"; readonly note?: string }>>;
  readonly freeze: { readonly target: string } | null;
};

export type ProjectBundle = {
  format: typeof BUNDLE_FORMAT;
  version: 2 | 3 | 4;
  exportedAt: string;
  project: { id: string; title: string; policy: unknown };
  artifacts: ExportedArtifact[];
  conversations: ExportedConversation[];
  notes: string;
  /** Absent from a v2 bundle. */
  workflow?: BundleWorkflow;
};

export type BundleDeps = {
  projectView: (projectId: string) => Promise<{
    project: { id: string; title: string; policy: unknown };
    tenantId: string;
    nodes: ArtifactNode[];
  }>;
  /** Every version of the artifact the store can read, oldest first, the last being the current one. */
  artifactVersions: (tenantId: string, nodeId: string) => Promise<ExportedVersion[]>;
  /** The graph's edges, each a node and one it was generated from; a bundle without them imports every node as a root. */
  artifactEdges?: (projectId: string) => Promise<readonly { childNodeId: string; sourceNodeId: string }[]>;
  /** Every address the stage's specialist has run at: a redeploy (send-back,
   *  restart, model switch) leaves earlier mail under earlier addresses. */
  stageAgentAddresses: (projectId: string, stage: number) => Promise<string[]>;
  readStageThread: (tenantId: string, addresses: string[]) => Promise<ChatMessage[]>;
  /** The workflow's view, for the position the bundle carries (#652); a bundle without it imports from its artifact heads. */
  workflowView?: (projectId: string) => Promise<{
    stage: number;
    done: boolean;
    decisions: readonly { kind: string; stage: number; accepted: boolean; artifactId?: string; version?: number; sha256?: string; targetStage?: number; target?: string }[];
    audienceDecisions: Readonly<Record<string, { decision: "proceed" | "revise" | "reject"; note?: string }>>;
    freeze: { target: string } | null;
  } | null>;
};

/** Only the fields a document node is documented to carry -- an explicit
 *  whitelist, not a spread, so an unexpected field on the read (a stray
 *  credential, say) can never ride along into the bundle. */
function pickNode(node: ArtifactNode): ExportedNode {
  return {
    id: node.id,
    kind: node.kind,
    variant: node.variant,
    stage: node.stage,
    title: node.title,
    version: node.version,
    artifactId: node.artifactId,
    contentHash: node.contentHash,
    ...(node.sizeBytes !== undefined ? { sizeBytes: node.sizeBytes } : {}),
    ...(node.mediaType !== undefined ? { mediaType: node.mediaType } : {}),
    createdAt: node.createdAt,
    supersededByNodeId: node.supersededByNodeId,
    provenance: { ...node.provenance },
  };
}

function pickMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    author: message.author,
    body: message.body,
    at: message.at,
    ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
  };
}

/**
 * Builds the export bundle for one project. Pure over `deps` so it needs no
 * network to test: every read is injected, nothing is fetched directly.
 * Provider configuration, credentials, tokens, cookies and session data are
 * never read here at all -- only the artifact graph's own content, stage
 * mail bodies, and the project's title/policy.
 */
export async function assembleBundle(projectId: string, deps: BundleDeps): Promise<ProjectBundle> {
  const detail = await deps.projectView(projectId);

  const bundled = new Set(detail.nodes.map((node) => node.id));
  const sourcesOf = new Map<string, string[]>();
  for (const edge of deps.artifactEdges ? await deps.artifactEdges(projectId).catch(() => []) : []) {
    if (!bundled.has(edge.childNodeId) || !bundled.has(edge.sourceNodeId)) continue;
    sourcesOf.set(edge.childNodeId, [...(sourcesOf.get(edge.childNodeId) ?? []), edge.sourceNodeId]);
  }

  const artifacts: ExportedArtifact[] = await Promise.all(
    detail.nodes.map(async (node) => {
      const versions = (await deps.artifactVersions(detail.tenantId, node.id)).map(({ version, content }) => ({ version, content }));
      return { node: pickNode(node), content: versions.at(-1)?.content ?? "", versions, sources: sourcesOf.get(node.id) ?? [] };
    }),
  );

  const conversations: ExportedConversation[] = [];
  for (const stage of STAGES) {
    const addresses = await deps.stageAgentAddresses(projectId, stage);
    if (addresses.length === 0) continue;
    const messages = await deps.readStageThread(detail.tenantId, addresses);
    if (messages.length === 0) continue;
    conversations.push({ stage, messages: messages.map(pickMessage) });
  }

  const view = deps.workflowView ? await deps.workflowView(projectId).catch(() => null) : null;
  const workflow: BundleWorkflow | undefined = view
    ? {
        stage: view.stage,
        done: view.done,
        decisions: view.decisions
          .filter((decision) => decision.accepted)
          .map((decision) => ({
            kind: decision.kind,
            stage: decision.stage,
            ...(decision.artifactId !== undefined ? { artifactId: decision.artifactId } : {}),
            ...(decision.version !== undefined ? { version: decision.version } : {}),
            ...(decision.sha256 !== undefined ? { sha256: decision.sha256 } : {}),
            ...(decision.targetStage !== undefined ? { targetStage: decision.targetStage } : {}),
            ...(decision.target !== undefined ? { target: decision.target } : {}),
          })),
        audienceDecisions: Object.fromEntries(
          Object.entries(view.audienceDecisions).map(([name, vote]) => [name, { decision: vote.decision, ...(vote.note ? { note: vote.note } : {}) }]),
        ),
        freeze: view.freeze ? { target: view.freeze.target } : null,
      }
    : undefined;

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: detail.project.id, title: detail.project.title, policy: detail.project.policy },
    artifacts,
    conversations,
    notes: workflow ? "the workflow's position is carried; the import replays it" : "workflow events are not included",
    ...(workflow ? { workflow } : {}),
  };
}

/** Validates an unknown value as a `ProjectBundle`, throwing a clear error
 *  naming what is wrong -- the parse side of the export, for whatever reads
 *  a bundle back (not import: see the PR body). */
export function parseBundle(value: unknown): ProjectBundle {
  if (typeof value !== "object" || value === null) {
    throw new Error("not a project bundle: expected an object");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== BUNDLE_FORMAT) {
    throw new Error(`not a project bundle: expected format "${BUNDLE_FORMAT}", got ${JSON.stringify(record.format)}`);
  }
  if (!READABLE_BUNDLE_VERSIONS.includes(record.version as number)) {
    throw new Error(`unsupported project bundle version: ${JSON.stringify(record.version)}`);
  }
  if (typeof record.exportedAt !== "string") {
    throw new Error("project bundle is missing exportedAt");
  }
  if (typeof record.project !== "object" || record.project === null) {
    throw new Error("project bundle is missing project");
  }
  const project = record.project as Record<string, unknown>;
  if (typeof project.id !== "string" || typeof project.title !== "string") {
    throw new Error("project bundle's project is missing id or title");
  }
  if (!("policy" in project)) {
    throw new Error("project bundle's project is missing policy");
  }
  if (!Array.isArray(record.artifacts)) {
    throw new Error("project bundle is missing artifacts");
  }
  for (const [index, artifact] of (record.artifacts as unknown[]).entries()) {
    const { versions, sources } = typeof artifact === "object" && artifact !== null ? (artifact as Record<string, unknown>) : {};
    if (versions !== undefined && (!Array.isArray(versions) || !versions.every(isExportedVersion))) {
      throw new Error(`project bundle's artifact ${String(index)} has a malformed versions array`);
    }
    if (sources !== undefined && (!Array.isArray(sources) || !sources.every((entry) => typeof entry === "string"))) {
      throw new Error(`project bundle's artifact ${String(index)} has a malformed sources array`);
    }
  }
  if (!Array.isArray(record.conversations)) {
    throw new Error("project bundle is missing conversations");
  }
  if (typeof record.notes !== "string") {
    throw new Error("project bundle is missing notes");
  }
  return record as ProjectBundle;
}

function isExportedVersion(value: unknown): value is ExportedVersion {
  return typeof value === "object" && value !== null && typeof (value as ExportedVersion).version === "number" && typeof (value as ExportedVersion).content === "string";
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "project"
  );
}

/** `<slug>.solutions-builder.json`, the export's default download name. */
export function bundleFileName(title: string): string {
  return `${slug(title)}.solutions-builder.json`;
}
