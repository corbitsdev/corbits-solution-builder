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
  /**
   * Stamped only by the explicit Approve path (`persistStageDraft`), never
   * by a stage's own draft/package/decision writes — the stage cursor
   * (`currentStageFromArtifacts`) advances only on this, not on an
   * artifact's mere existence (CL-8639).
   */
  approvedAt?: string;
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
  /** `sb.approvedAt`, or null when this version has never been explicitly approved. */
  approvedAt: string | null;
};

export type ArtifactGraphEdge = {
  childNodeId: string;
  sourceNodeId: string;
};

export type ArtifactGraph = {
  nodes: ArtifactGraphNode[];
  edges: ArtifactGraphEdge[];
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

  const nodes: ArtifactGraphNode[] = scoped.map(({ entry, sb }) => ({
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
    approvedAt: sb.approvedAt ?? null,
  }));

  const edges: ArtifactGraphEdge[] = scoped.flatMap(({ entry, sb }) =>
    sb.sourceVersionIds.map((sourceVersionId) => ({
      childNodeId: entry.id,
      sourceNodeId: artifactIdFromVersionId(sourceVersionId),
    })),
  );

  return { nodes, edges };
}
