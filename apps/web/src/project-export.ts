/**
 * A project exported as one JSON bundle, assembled entirely in the browser
 * from reads the client already has: the artifact graph and its content,
 * each deployed stage's mail thread, and the project's own title and policy
 * (CL-8702). No import path exists yet -- see the PR body.
 */
import type { ArtifactNode } from "./client.ts";
import type { ChatMessage } from "./stage-mail.ts";

export const BUNDLE_FORMAT = "solutions-builder.project" as const;
export const BUNDLE_VERSION = 2 as const;
const STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type ExportedArtifact = { node: ArtifactNode; content: string };
export type ExportedConversation = { stage: number; messages: ChatMessage[] };

export type ProjectBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  project: { id: string; title: string; policy: unknown };
  artifacts: ExportedArtifact[];
  conversations: ExportedConversation[];
  notes: string;
};

export type BundleDeps = {
  projectView: (projectId: string) => Promise<{
    project: { id: string; title: string; policy: unknown };
    tenantId: string;
    nodes: ArtifactNode[];
  }>;
  artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
  stageAgentStatus: (projectId: string, stage: number) => Promise<{ address: string } | null>;
  readStageThread: (tenantId: string, addresses: string[]) => Promise<ChatMessage[]>;
};

/** Only the fields a document node is documented to carry -- an explicit
 *  whitelist, not a spread, so an unexpected field on the read (a stray
 *  credential, say) can never ride along into the bundle. */
function pickNode(node: ArtifactNode): ArtifactNode {
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
    approvedAt: node.approvedAt,
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

  const artifacts: ExportedArtifact[] = await Promise.all(
    detail.nodes.map(async (node) => ({
      node: pickNode(node),
      content: (await deps.artifactContent(detail.tenantId, node.id)).content,
    })),
  );

  const conversations: ExportedConversation[] = [];
  for (const stage of STAGES) {
    const status = await deps.stageAgentStatus(projectId, stage);
    if (!status) continue;
    const messages = await deps.readStageThread(detail.tenantId, [status.address]);
    if (messages.length === 0) continue;
    conversations.push({ stage, messages: messages.map(pickMessage) });
  }

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: detail.project.id, title: detail.project.title, policy: detail.project.policy },
    artifacts,
    conversations,
    notes: "workflow events are not included yet",
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
  if (record.version !== BUNDLE_VERSION) {
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
  if (!Array.isArray(record.conversations)) {
    throw new Error("project bundle is missing conversations");
  }
  if (typeof record.notes !== "string") {
    throw new Error("project bundle is missing notes");
  }
  return record as ProjectBundle;
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
