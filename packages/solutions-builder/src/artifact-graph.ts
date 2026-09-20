/**
 * The artifact graph as a client fold over `@corbits/artifacts` metadata —
 * CL-8500 decision 3. The mounted package's `GET /artifacts` list route
 * filters by kind/owner/date only, never by project, so a project's graph is
 * assembled here, in memory, from a tenant's full artifact list.
 *
 * The `sb` metadata contract below is what a writer stamps on an artifact
 * version's opaque `metadata` field so this fold can read it back. Field
 * names mirror the deleted `apps/hub/src/schema.ts`'s `artifactNode` table
 * and the deleted `apps/hub/src/domain.ts`'s `ArtifactDraft.provenance` on
 * purpose, so the old shape and the new metadata read the same.
 */

/** Mirrors the deleted `apps/hub/src/domain.ts`'s `ArtifactDraft.provenance`. */
export type ArtifactProvenance = {
  producer: "human" | "agent";
  agentRole?: string;
  providerId?: string;
  model?: string;
  runId?: string;
  promptKey?: string;
};

/** Mirrors the deleted `apps/hub/src/schema.ts`'s `artifactNode` columns, minus what `@corbits/artifacts` already owns (id, version, title, createdAt). */
export type ArtifactGraphMetadata = {
  projectId: string;
  kind: string;
  stage: number;
  variant?: string;
  /** The artifact id this version supersedes, if any — the inverse of `supersededByNodeId`. */
  supersedes?: string;
  /** Exact versions this draft was generated from. Empty only at a graph root. */
  sourceVersionIds: string[];
  provenance: ArtifactProvenance;
  /**
   * The draft's own media type. `@corbits/artifacts` does not model this, so
   * the fold reads it back here to fill `ArtifactGraphNode.mediaType` (CL-8501).
   */
  mediaType: string;
};

/** The metadata contract on an artifact version: everything Builder owns lives under `sb`. */
export type ArtifactMetadata = {
  sb: ArtifactGraphMetadata;
};

/**
 * One item from `packages/installer/src/artifacts.ts`'s `listArtifacts`
 * (the mounted `@corbits/artifacts` `GET /artifacts` list route), narrowed to
 * what the fold reads. That route already mirrors the current version's
 * `metadata` on every list item, so no per-artifact fetch is needed to read
 * `metadata.sb`.
 */
export type ArtifactListEntry = {
  id: string;
  version: number;
  title: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  /** Opaque; read here only for `source.upload.size` (CL-8709) — an uploaded
   *  file's real byte count, which the list route otherwise has no place to
   *  carry since `content` is omitted from it. */
  source?: Record<string, unknown> & { origin: string };
  /** The current version's real content digest — `@corbits/artifacts`
   *  computes this for every artifact, text or binary (CL-8723). Unlike
   *  `versionId`, this is a sha256 over the actual bytes, so it is what a
   *  stage approval's `ref.sha256` should carry for an artifact a specialist
   *  wrote directly, rather than a hash of unrelated chat prose. */
  contentSha256?: string | null;
};

export type ArtifactGraphNode = {
  id: string;
  versionId: string;
  kind: string;
  stage: number;
  variant: string | null;
  title: string;
  mediaType?: string;
  supersededByNodeId: string | null;
  provenance: ArtifactProvenance;
  createdAt: string;
  /** `source.upload.size`, when this version is a package upload record; unset otherwise (CL-8709). */
  sizeBytes?: number;
  /** The current version's real content digest, when the mounted package
   *  recorded one (CL-8723) — a real hash over the bytes, unlike `versionId`. */
  contentSha256?: string | null;
};

export type ArtifactGraphEdge = {
  childNodeId: string;
  sourceNodeId: string;
};

export type ArtifactGraph = {
  nodes: ArtifactGraphNode[];
  edges: ArtifactGraphEdge[];
};

export const DESIGN_FEEDBACK_DISPOSITIONS = ["open", "addressed", "declined"] as const;
export type DesignFeedbackDisposition = (typeof DESIGN_FEEDBACK_DISPOSITIONS)[number];

/**
 * One anchored (or whole-design) comment recorded on a design node's own
 * `sb.feedback` array (CL-8620) — not folded into `ArtifactGraphNode` since it
 * lives beside the graph fields, keyed to one node rather than the project.
 * `disposition` defaults to "open" when absent, and is set only by an
 * explicit person action against a comment's `id` — never by a new design
 * version arriving, which never touches this array (CL-8699). `id` is
 * optional because a row written before CL-8699 has none; such a row cannot
 * be addressed by id and gets a rendering-only fallback (CL-8699 follow-up).
 */
export type DesignFeedbackEntry = {
  id?: string;
  nodeId: string;
  anchor?: { testId?: string; domPath?: string; role?: string; textFingerprint?: string };
  text: string;
  at: string;
  disposition?: DesignFeedbackDisposition;
  dispositionAt?: string;
};

/**
 * A version id derived purely from list data — `@corbits/artifacts` has no
 * separate version-row id on its list route, only `(id, version)`. Writers
 * populating `sourceVersionIds` (CL-8500) must use this same encoding, since
 * it is what this fold turns back into a source node id for `/graph`'s edges.
 */
export function versionIdFor(artifactId: string, version: number): string {
  return `${artifactId}@${version}`;
}

function artifactIdFromVersionId(versionId: string): string {
  return versionId.slice(0, versionId.lastIndexOf("@"));
}

function readSb(entry: ArtifactListEntry): ArtifactGraphMetadata | null {
  const metadata = entry.metadata as Partial<ArtifactMetadata> | null;
  const sb = metadata?.sb;
  return sb && typeof sb === "object" ? sb : null;
}

function readUploadSize(entry: ArtifactListEntry): number | undefined {
  const size = (entry.source as { upload?: { size?: unknown } } | undefined)?.upload?.size;
  return typeof size === "number" ? size : undefined;
}

/**
 * Folds one project's node/edge graph from a tenant's full artifact list.
 * Artifacts outside `projectId` (or with no `sb` metadata yet) are dropped.
 */
export function foldArtifactGraph(artifacts: ArtifactListEntry[], projectId: string): ArtifactGraph {
  const scoped = artifacts
    .map((entry) => ({ entry, sb: readSb(entry) }))
    .filter((row): row is { entry: ArtifactListEntry; sb: ArtifactGraphMetadata } => row.sb?.projectId === projectId);

  const supersededBy = new Map<string, string>();
  for (const { entry, sb } of scoped) {
    if (sb.supersedes) supersededBy.set(sb.supersedes, entry.id);
  }

  const nodes: ArtifactGraphNode[] = scoped.map(({ entry, sb }) => {
    const sizeBytes = readUploadSize(entry);
    return {
      id: entry.id,
      versionId: versionIdFor(entry.id, entry.version),
      kind: sb.kind,
      stage: sb.stage,
      variant: sb.variant ?? null,
      title: entry.title,
      mediaType: sb.mediaType,
      supersededByNodeId: supersededBy.get(entry.id) ?? null,
      provenance: sb.provenance,
      createdAt: entry.createdAt,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      contentSha256: entry.contentSha256 ?? null,
    };
  });

  const edges: ArtifactGraphEdge[] = scoped.flatMap(({ entry, sb }) =>
    sb.sourceVersionIds.map((sourceVersionId) => ({
      childNodeId: entry.id,
      sourceNodeId: artifactIdFromVersionId(sourceVersionId),
    })),
  );

  return { nodes, edges };
}
