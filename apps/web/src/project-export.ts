/**
 * A project exported as one zip, assembled entirely in the browser from
 * reads the client already has: every version of every artifact, each
 * deployed stage's mail thread, the workflow's reviews and decisions, and
 * the project's own title and policy (CL-8702). `project.json` holds the
 * state; each artifact version is a real file under `artifacts/`, and each
 * recorded build archive with its manifest under `builds/<attempt>/`, named
 * from `project.json` by path. `project-import.ts` reads it back.
 *
 * Bundle versions:
 * - v2/v3 JSON (`ProjectBundle`): one content per artifact. v3 carries the
 *   slim workflow (#652). Import still goes through `bundle-adoption.ts`.
 * - v4 zip (`ArchiveBundle`): every version as a file. This is what export
 *   writes now. v3 is not reused — main already shipped v3 as JSON.
 */
import JSZip from "jszip";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { STAGES } from "@solutions-builder/app/ledger";
import type { ArtifactNode } from "./client.ts";
import { bytesOf, documentExtension } from "./documents-archive.ts";
import { withLineagePositions } from "./project-view.ts";
import type { ChatMessage } from "./stage-mail.ts";

export const BUNDLE_FORMAT = "solutions-builder.project" as const;
/** Zip with every artifact version as a file. New exports write this. */
export const BUNDLE_VERSION = 4 as const;
/** One JSON file, one content per artifact. v3 carries the slim workflow (#652). */
export const JSON_BUNDLE_VERSIONS: readonly number[] = [2, 3];
export const READABLE_BUNDLE_VERSIONS: readonly number[] = [2, 3, 4];
export const ARCHIVE_STATE_FILE = "project.json";

/** A node as recorded; its lineage position is derived when a project is read. */
export type ExportedNode = Omit<ArtifactNode, "position">;
/** One of an artifact's own versions, 1 to `node.version`. */
export type ExportedVersion = { version: number; content: string };
export type ExportedArtifact = { node: ExportedNode; versions: ExportedVersion[] };
export type JsonExportedArtifact = { node: ExportedNode; content: string };
export type ExportedConversation = { stage: number; messages: ChatMessage[] };

/** Slim workflow a v3 JSON bundle carries (#652). */
export type BundleWorkflow = {
  readonly stage: number;
  readonly done: boolean;
  readonly decisions: readonly {
    readonly kind: string;
    readonly stage: number;
    readonly artifactId?: string;
    readonly version?: number;
    readonly sha256?: string;
    readonly targetStage?: number;
    readonly target?: string;
  }[];
  readonly audienceDecisions: Readonly<Record<string, { readonly decision: "proceed" | "revise" | "reject"; readonly note?: string }>>;
  readonly freeze: { readonly target: string } | null;
};

/** What a v4 zip replays approvals from: a whitelist, never the whole view. */
export type ExportedReview = {
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
  readonly status: string;
};

export type ExportedWorkflow = {
  readonly stage: number;
  readonly done: boolean;
  readonly reviews: Readonly<Record<number, ExportedReview | undefined>>;
  readonly decisions: readonly {
    readonly kind: string;
    readonly stage: number;
    readonly accepted?: boolean;
    readonly artifactId?: string;
    readonly version?: number;
    readonly sha256?: string;
    readonly targetStage?: number;
    readonly target?: string;
  }[];
  readonly votes: Readonly<Record<string, { readonly decision: "proceed" | "revise" | "reject"; readonly note?: string }>>;
  readonly freeze: { readonly target: string } | null;
  readonly audiencePolicy?: { readonly quorum: number; readonly stakeholders: readonly string[] } | null;
  readonly audiencePackages: Readonly<Record<string, { readonly artifactId: string; readonly version: number; readonly sha256: string }>>;
  readonly requirements: readonly { readonly kind: string; readonly text: string }[];
};

/** v2/v3 JSON: one content per artifact. `bundle-adoption.ts` reads this. */
export type ProjectBundle = {
  format: typeof BUNDLE_FORMAT;
  version: 2 | 3;
  exportedAt: string;
  project: { id: string; title: string; policy: unknown };
  artifacts: JsonExportedArtifact[];
  conversations: ExportedConversation[];
  notes: string;
  /** Absent from a v2 bundle. */
  workflow?: BundleWorkflow;
};

/** v4 zip: every version of every artifact. */
export type ArchiveBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  project: { id: string; title: string; policy: unknown };
  artifacts: ExportedArtifact[];
  conversations: ExportedConversation[];
  workflow: ExportedWorkflow | null;
};

export type ParsedBundle = ProjectBundle | ArchiveBundle;

/** A version in `project.json`: the file holding it, and the `data:` header its bytes were decoded from. */
export type ArchivedVersion = { version: number; path: string; dataUrlHeader?: string };

/** Fields `assembleBundle` reads off the workflow view — a whitelist, not the view itself. */
export type WorkflowExportView = {
  stage: number;
  done: boolean;
  reviews: Readonly<Record<number, { artifactId: string; version: number; sha256: string; status: string } | undefined>>;
  decisions: readonly {
    kind: string;
    stage: number;
    accepted: boolean;
    artifactId?: string;
    version?: number;
    sha256?: string;
    targetStage?: number;
    target?: string;
  }[];
  audienceDecisions: Readonly<Record<string, { decision: "proceed" | "revise" | "reject"; note?: string }>>;
  freeze: { target: string } | null;
  audiencePolicy?: { quorum: number; stakeholders: readonly string[] } | null;
  audiencePackages: Readonly<Record<string, { artifactId: string; version: number; sha256: string }>>;
  requirements: readonly { kind: string; text: string }[];
};

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
  projectWorkflowView: (projectId: string) => Promise<WorkflowExportView | null>;
};

export function isArchiveBundle(bundle: ParsedBundle): bundle is ArchiveBundle {
  return bundle.version === BUNDLE_VERSION;
}

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

function pickWorkflow(view: WorkflowExportView): ExportedWorkflow {
  const reviews: Record<number, ExportedReview> = {};
  for (const [stage, review] of Object.entries(view.reviews)) {
    if (!review) continue;
    reviews[Number(stage)] = {
      artifactId: review.artifactId,
      version: review.version,
      sha256: review.sha256,
      status: review.status,
    };
  }
  return {
    stage: view.stage,
    done: view.done,
    reviews,
    decisions: view.decisions.map((decision) => ({
      kind: decision.kind,
      stage: decision.stage,
      accepted: decision.accepted,
      ...(decision.artifactId !== undefined ? { artifactId: decision.artifactId } : {}),
      ...(decision.version !== undefined ? { version: decision.version } : {}),
      ...(decision.sha256 !== undefined ? { sha256: decision.sha256 } : {}),
      ...(decision.targetStage !== undefined ? { targetStage: decision.targetStage } : {}),
      ...(decision.target !== undefined ? { target: decision.target } : {}),
    })),
    votes: Object.fromEntries(
      Object.entries(view.audienceDecisions).map(([name, vote]) => [name, { decision: vote.decision, ...(vote.note ? { note: vote.note } : {}) }]),
    ),
    freeze: view.freeze ? { target: view.freeze.target } : null,
    ...(view.audiencePolicy ? { audiencePolicy: { quorum: view.audiencePolicy.quorum, stakeholders: [...view.audiencePolicy.stakeholders] } } : {}),
    audiencePackages: Object.fromEntries(
      Object.entries(view.audiencePackages).map(([name, ref]) => [name, { artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256 }]),
    ),
    requirements: view.requirements.map((entry) => ({ kind: entry.kind, text: entry.text })),
  };
}

/**
 * Builds the export bundle for one project. Pure over `deps` so it needs no
 * network to test: every read is injected, nothing is fetched directly.
 * Provider configuration, credentials, tokens, cookies and session data are
 * never read here at all -- only the artifact graph's own content, stage
 * mail bodies, the workflow's record, and the project's title/policy.
 */
export async function assembleBundle(projectId: string, deps: BundleDeps): Promise<ArchiveBundle> {
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

  const view = await deps.projectWorkflowView(projectId).catch(() => null);

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
export function archiveBundle(bundle: ArchiveBundle): JSZip {
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

function parseNode(value: unknown, index: number): ExportedNode {
  if (!isRecord(value)) throw new Error(`project bundle's artifact ${String(index)} is missing its node`);
  for (const key of ["id", "kind", "title", "createdAt"] as const) {
    if (typeof value[key] !== "string") throw new Error(`project bundle's artifact ${String(index)} is missing ${key}`);
  }
  if (typeof value.stage !== "number" || typeof value.version !== "number") {
    throw new Error(`project bundle's artifact ${String(index)} is missing stage or version`);
  }
  return value as unknown as ExportedNode;
}

function parseArchiveArtifact(value: unknown, index: number): ExportedArtifact {
  if (!isRecord(value)) throw new Error(`project bundle's artifact ${String(index)} is missing its node`);
  const node = parseNode(value.node, index);
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    throw new Error(`project bundle's artifact ${String(index)} has no versions`);
  }
  const versions = value.versions.map((entry: unknown): ExportedVersion => {
    if (!isRecord(entry) || typeof entry.version !== "number") throw new Error(`project bundle's artifact ${String(index)} has a version with no number`);
    if (typeof entry.content !== "string") {
      throw new Error(`project bundle's artifact ${node.title} version ${String(entry.version)} has no content; import the .zip its project.json came in`);
    }
    return { version: entry.version, content: entry.content };
  });
  return { node, versions };
}

function parseJsonArtifact(value: unknown, index: number): JsonExportedArtifact {
  if (!isRecord(value)) throw new Error(`project bundle's artifact ${String(index)} is missing its node`);
  const node = parseNode(value.node, index);
  if (typeof value.content !== "string") {
    throw new Error(`project bundle's artifact ${String(index)} is missing content`);
  }
  return { node, content: value.content };
}

function parseShared(value: Record<string, unknown>): {
  exportedAt: string;
  project: { id: string; title: string; policy: unknown };
  conversations: ExportedConversation[];
} {
  if (typeof value.exportedAt !== "string") throw new Error("project bundle is missing exportedAt");
  if (!isRecord(value.project)) throw new Error("project bundle is missing project");
  const project = value.project;
  if (typeof project.id !== "string" || typeof project.title !== "string") {
    throw new Error("project bundle's project is missing id or title");
  }
  if (!("policy" in project)) throw new Error("project bundle's project is missing policy");
  if (!Array.isArray(value.artifacts)) throw new Error("project bundle is missing artifacts");
  if (!Array.isArray(value.conversations)) throw new Error("project bundle is missing conversations");
  return {
    exportedAt: value.exportedAt,
    project: { id: project.id, title: project.title, policy: project.policy },
    conversations: value.conversations as ExportedConversation[],
  };
}

function parseJsonBundle(value: Record<string, unknown>): ProjectBundle {
  if (typeof value.notes !== "string") throw new Error("project bundle is missing notes");
  const shared = parseShared(value);
  const artifacts = (value.artifacts as unknown[]).map(parseJsonArtifact);
  return {
    format: BUNDLE_FORMAT,
    version: value.version === 3 ? 3 : 2,
    ...shared,
    artifacts,
    notes: value.notes,
    ...(isRecord(value.workflow)
      ? {
          workflow: {
            stage: typeof value.workflow.stage === "number" ? value.workflow.stage : 1,
            done: value.workflow.done === true,
            decisions: Array.isArray(value.workflow.decisions) ? (value.workflow.decisions as BundleWorkflow["decisions"]) : [],
            audienceDecisions: isRecord(value.workflow.audienceDecisions)
              ? (value.workflow.audienceDecisions as BundleWorkflow["audienceDecisions"])
              : {},
            freeze: isRecord(value.workflow.freeze) && typeof value.workflow.freeze.target === "string" ? { target: value.workflow.freeze.target } : null,
          },
        }
      : {}),
  };
}

function parseArchiveBundle(value: Record<string, unknown>): ArchiveBundle {
  const shared = parseShared(value);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    ...shared,
    artifacts: (value.artifacts as unknown[]).map(parseArchiveArtifact),
    workflow: isRecord(value.workflow) ? (value.workflow as unknown as ExportedWorkflow) : null,
  };
}

/** Validates an unknown value as a project bundle, throwing a clear error
 *  naming what is wrong. v2/v3 JSON stay the one-content format; v4 is the zip. */
export function parseBundle(value: unknown): ParsedBundle {
  if (!isRecord(value)) throw new Error("not a project bundle: expected an object");
  if (value.format !== BUNDLE_FORMAT) {
    throw new Error(`not a project bundle: expected format "${BUNDLE_FORMAT}", got ${JSON.stringify(value.format)}`);
  }
  if (!READABLE_BUNDLE_VERSIONS.includes(value.version as number)) {
    throw new Error(`unsupported project bundle version: ${JSON.stringify(value.version)}`);
  }
  if (value.version === BUNDLE_VERSION) return parseArchiveBundle(value);
  if (!JSON_BUNDLE_VERSIONS.includes(value.version as number)) {
    throw new Error(`unsupported project bundle version: ${JSON.stringify(value.version)}`);
  }
  return parseJsonBundle(value);
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
