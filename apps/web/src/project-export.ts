/**
 * A project exported as one zip, assembled entirely in the browser from
 * reads the client already has: every version of every artifact, each
 * deployed stage's mail thread, the workflow's reviews and decisions, and
 * the project's own title and policy (CL-8702). `project.json` holds the
 * state; each artifact version is a real file under `artifacts/`, and each
 * recorded build archive with its manifest under `builds/<attempt>/`, named
 * from `project.json` by path. `project-import.ts` reads it back.
 */
import JSZip from "jszip";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { STAGES } from "@solutions-builder/app/ledger";
import type { ArtifactNode } from "./client.ts";
import { bytesOf, documentExtension } from "./documents-archive.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import { withLineagePositions } from "./project-view.ts";
import type { ChatMessage } from "./stage-mail.ts";

export const BUNDLE_FORMAT = "solutions-builder.project" as const;
export const BUNDLE_VERSION = 3 as const;
/** One JSON file, one content per artifact, no workflow: still read on import. */
export const JSON_BUNDLE_VERSION = 2 as const;
export const ARCHIVE_STATE_FILE = "project.json";

/** A node as recorded; its lineage position is derived when a project is read. */
export type ExportedNode = Omit<ArtifactNode, "position">;
/** One of an artifact's own versions, 1 to `node.version`. */
export type ExportedVersion = { version: number; content: string };
export type ExportedArtifact = { node: ExportedNode; versions: ExportedVersion[] };
export type ExportedConversation = { stage: number; messages: ChatMessage[] };
/** What the import replays approvals from. */
export type ExportedWorkflow = Pick<
  ProjectWorkflowView,
  "stage" | "done" | "reviews" | "decisions" | "audiencePolicy" | "audienceDecisions" | "audiencePackages" | "requirements"
>;

export type ProjectBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  project: { id: string; title: string; policy: unknown };
  artifacts: ExportedArtifact[];
  conversations: ExportedConversation[];
  /** Null for a project whose workflow never started, and for a version 2 bundle. */
  workflow: ExportedWorkflow | null;
};

/** A version in `project.json`: the file holding it, and the `data:` header its bytes were decoded from. */
export type ArchivedVersion = { version: number; path: string; dataUrlHeader?: string };

export type BundleDeps = {
  projectView: (projectId: string) => Promise<{
    project: { id: string; title: string; policy: unknown };
    tenantId: string;
    nodes: ArtifactNode[];
  }>;
  /** `nodeId` may pin a version (`versionIdFor`). */
  artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
  /** Every address the stage's specialist has run at: a redeploy (send-back,
   *  restart, model switch) leaves earlier mail under earlier addresses. */
  stageAgentAddresses: (projectId: string, stage: number) => Promise<string[]>;
  readStageThread: (tenantId: string, addresses: string[]) => Promise<ChatMessage[]>;
  projectWorkflowView: (projectId: string) => Promise<ProjectWorkflowView | null>;
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
    ...(node.contentSha256 ? { contentSha256: node.contentSha256 } : {}),
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

function pickWorkflow(view: ProjectWorkflowView): ExportedWorkflow {
  return {
    stage: view.stage,
    done: view.done,
    reviews: view.reviews,
    decisions: view.decisions,
    audiencePolicy: view.audiencePolicy,
    audienceDecisions: view.audienceDecisions,
    audiencePackages: view.audiencePackages,
    requirements: view.requirements,
  };
}

/**
 * Builds the export bundle for one project. Pure over `deps` so it needs no
 * network to test: every read is injected, nothing is fetched directly.
 * Provider configuration, credentials, tokens, cookies and session data are
 * never read here at all -- only the artifact graph's own content, stage
 * mail bodies, the workflow's record, and the project's title/policy.
 */
export async function assembleBundle(projectId: string, deps: BundleDeps): Promise<ProjectBundle> {
  const detail = await deps.projectView(projectId);

  const artifacts: ExportedArtifact[] = await Promise.all(
    detail.nodes.map(async (node) => ({
      node: pickNode(node),
      versions: await Promise.all(
        Array.from({ length: node.version }, async (_, at) => ({
          version: at + 1,
          content: (await deps.artifactContent(detail.tenantId, versionIdFor(node.id, at + 1))).content,
        })),
      ),
    })),
  );

  const conversations: ExportedConversation[] = [];
  for (const stage of STAGES) {
    const addresses = await deps.stageAgentAddresses(projectId, stage);
    if (addresses.length === 0) continue;
    const messages = await deps.readStageThread(detail.tenantId, addresses);
    if (messages.length === 0) continue;
    conversations.push({ stage, messages: messages.map(pickMessage) });
  }

  const view = await deps.projectWorkflowView(projectId);

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: detail.project.id, title: detail.project.title, policy: detail.project.policy },
    artifacts,
    conversations,
    workflow: view ? pickWorkflow(view) : null,
  };
}

function isBuildArchive(node: ExportedNode): boolean {
  return node.kind === "build_evidence" && node.mediaType === "application/gzip";
}

function isBuildManifest(node: ExportedNode): boolean {
  return node.kind === "delivery_manifest" && node.stage === 8;
}

/** `name.ext` → `name-2.ext` until unused, so two records never share a file. */
function claim(taken: Set<string>, path: string): string {
  const dot = path.indexOf(".", path.lastIndexOf("/"));
  const [stem, ext] = dot < 0 ? [path, ""] : [path.slice(0, dot), path.slice(dot)];
  let candidate = path;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stem}-${String(n)}${ext}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Where each artifact version goes: a build archive and its manifest at
 * `builds/<attempt>/build.tar.gz` and `manifest.json`; everything else at
 * `artifacts/<stage>-<kind>[-<stakeholder>]/v<n>.<ext>`, `n` being the
 * artifact's place in that lineage, as the version strip numbers it, with
 * an artifact's earlier own versions beside it as `v<n>-r<version>.<ext>`.
 */
function archivePaths(artifacts: readonly ExportedArtifact[]): Map<ExportedVersion, string> {
  const taken = new Set<string>([ARCHIVE_STATE_FILE]);
  const paths = new Map<ExportedVersion, string>();
  const positioned = withLineagePositions(artifacts.map(({ node, versions }) => ({ ...node, versions })));
  const oldestFirst = positioned.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const { versions, position, ...node } of oldestFirst) {
    const folder = `${String(node.stage).padStart(2, "0")}-${slug(node.kind)}${node.variant ? `-${slug(node.variant)}` : ""}`;
    for (const entry of versions) {
      const current = entry.version === node.version;
      const path = isBuildArchive(node)
        ? `builds/${slug(node.variant ?? "unnumbered")}/build${current ? "" : `-r${String(entry.version)}`}.tar.gz`
        : isBuildManifest(node)
          ? `builds/${slug(node.variant ?? "unnumbered")}/manifest${current ? "" : `-r${String(entry.version)}`}.json`
          : `artifacts/${folder}/v${String(position)}${current ? "" : `-r${String(entry.version)}`}.${documentExtension(node, entry.content)}`;
      paths.set(entry, claim(taken, path));
    }
  }
  return paths;
}

/** The export as a zip: `project.json` naming every version by path, and each version as its own file. */
export function archiveBundle(bundle: ProjectBundle): JSZip {
  const zip = new JSZip();
  const paths = archivePaths(bundle.artifacts);
  const artifacts = bundle.artifacts.map(({ node, versions }) => ({
    node,
    versions: versions.map((entry): ArchivedVersion => {
      const path = paths.get(entry)!;
      const comma = entry.content.indexOf(",");
      const header = entry.content.startsWith("data:") && entry.content.slice(0, comma).endsWith(";base64") ? entry.content.slice(0, comma + 1) : null;
      zip.file(path, header ? bytesOf(entry.content) : entry.content);
      return { version: entry.version, path, ...(header ? { dataUrlHeader: header } : {}) };
    }),
  }));
  zip.file(ARCHIVE_STATE_FILE, JSON.stringify({ ...bundle, artifacts }, null, 2));
  return zip;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArtifact(value: unknown, index: number): ExportedArtifact {
  if (!isRecord(value) || !isRecord(value.node)) throw new Error(`project bundle's artifact ${String(index)} is missing its node`);
  const node = value.node;
  for (const key of ["id", "kind", "title", "createdAt"] as const) {
    if (typeof node[key] !== "string") throw new Error(`project bundle's artifact ${String(index)} is missing ${key}`);
  }
  if (typeof node.stage !== "number" || typeof node.version !== "number") {
    throw new Error(`project bundle's artifact ${String(index)} is missing stage or version`);
  }
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    throw new Error(`project bundle's artifact ${String(index)} has no versions`);
  }
  const versions = value.versions.map((entry: unknown): ExportedVersion => {
    if (!isRecord(entry) || typeof entry.version !== "number") throw new Error(`project bundle's artifact ${String(index)} has a version with no number`);
    if (typeof entry.content !== "string") {
      throw new Error(`project bundle's artifact ${node.title as string} version ${String(entry.version)} has no content; import the .zip its project.json came in`);
    }
    return { version: entry.version, content: entry.content };
  });
  return { node: node as unknown as ExportedNode, versions };
}

/** Validates an unknown value as a `ProjectBundle`, throwing a clear error
 *  naming what is wrong. A version 2 bundle reads as one version per
 *  artifact and no workflow. */
export function parseBundle(value: unknown): ProjectBundle {
  if (!isRecord(value)) throw new Error("not a project bundle: expected an object");
  if (value.format !== BUNDLE_FORMAT) {
    throw new Error(`not a project bundle: expected format "${BUNDLE_FORMAT}", got ${JSON.stringify(value.format)}`);
  }
  if (value.version !== BUNDLE_VERSION && value.version !== JSON_BUNDLE_VERSION) {
    throw new Error(`unsupported project bundle version: ${JSON.stringify(value.version)}`);
  }
  if (typeof value.exportedAt !== "string") throw new Error("project bundle is missing exportedAt");
  if (!isRecord(value.project)) throw new Error("project bundle is missing project");
  const project = value.project;
  if (typeof project.id !== "string" || typeof project.title !== "string") throw new Error("project bundle's project is missing id or title");
  if (!("policy" in project)) throw new Error("project bundle's project is missing policy");
  if (!Array.isArray(value.artifacts)) throw new Error("project bundle is missing artifacts");
  if (!Array.isArray(value.conversations)) throw new Error("project bundle is missing conversations");
  const artifacts =
    value.version === JSON_BUNDLE_VERSION
      ? value.artifacts.map((entry: unknown, index) => parseArtifact(isRecord(entry) ? { node: entry.node, versions: [{ version: 1, content: entry.content }] } : entry, index))
      : value.artifacts.map(parseArtifact);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: value.exportedAt,
    project: { id: project.id, title: project.title, policy: project.policy },
    artifacts,
    conversations: value.conversations as ExportedConversation[],
    workflow: isRecord(value.workflow) ? (value.workflow as unknown as ExportedWorkflow) : null,
  };
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

/** `<slug>.solutions-builder.zip`, the export's default download name. */
export function bundleFileName(title: string): string {
  return `${slug(title)}.solutions-builder.zip`;
}
