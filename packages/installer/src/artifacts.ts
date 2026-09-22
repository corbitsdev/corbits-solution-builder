/**
 * A typed client for the `@corbits/artifacts` module the hub mounts
 * (`packages/embed-hub`), over nothing but `Transport` — the same interface
 * `packages/embedded-host/src/hub-client.ts`'s `artifacts` helpers are built on, rebuilt
 * here because `packages/installer/src` may not import `apps/hub/src`.
 *
 * `content` on `Artifact` is always the CURRENT version: the module's HTTP
 * surface has no route for an older version's body, only its metadata
 * (`versions`).
 */
import type { Transport } from "@intx/hub-client";

function tenantPathFor(scope: string, rest: string): string {
  return `/api/tenants/${scope}${rest}`;
}

export type Artifact = {
  id: string;
  kind: string;
  title: string;
  source: Record<string, unknown> & { origin: string };
  version: number;
  ownerPrincipalId: string | null;
  metadata: Record<string, unknown> | null;
  /** The current version's content digest (CL-8719, `@corbits/artifacts` 0190e6c). Null only for a version predating that migration's backfill. */
  contentSha256: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  content: string;
};

export type ArtifactListItem = Omit<Artifact, "content">;

/**
 * Every artifact in the tenant, newest-updated first (the route's default
 * order). `ArtifactListItem.metadata` already mirrors the current version's
 * `metadata` (the mount's own list serializer keeps them in lockstep), so
 * this is also the read path `@solutions-builder/app/artifact-graph`'s
 * `foldArtifactGraph` needs: no per-artifact fetch to see `metadata.sb` — see
 * CL-8500 decision 3 and CL-8502. The route filters by kind/owner/date only,
 * never by project, so scoping to one project happens in that fold, not here.
 */
export async function listArtifacts(
  transport: Transport,
  tenantId: string,
  filters: { kind?: string } = {},
): Promise<ArtifactListItem[]> {
  const items: ArtifactListItem[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "100", ...(filters.kind ? { kind: filters.kind } : {}) });
    if (cursor) params.set("cursor", cursor);
    const page = await transport.fetch<{ artifacts: ArtifactListItem[]; nextCursor: string | null }>(
      "GET",
      tenantPathFor(tenantId, `/artifacts?${params.toString()}`),
    );
    items.push(...page.artifacts);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Imports a pasted body as a new artifact, version 1. */
export async function createArtifact(
  transport: Transport,
  tenantId: string,
  input: { title: string; content: string; metadata?: Record<string, unknown> | null },
): Promise<Artifact> {
  const { artifact } = await transport.fetch<{ artifact: Artifact }>(
    "POST",
    tenantPathFor(tenantId, "/artifacts"),
    {
      mode: "text",
      title: input.title,
      content: input.content,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  );
  return artifact;
}

/** The artifact at its current version, or null if it does not exist (or is not visible). */
export async function getArtifact(
  transport: Transport,
  tenantId: string,
  artifactId: string,
): Promise<Artifact | null> {
  try {
    const { artifact } = await transport.fetch<{ artifact: Artifact }>(
      "GET",
      tenantPathFor(tenantId, `/artifacts/${artifactId}`),
    );
    return artifact;
  } catch {
    return null;
  }
}

/** Revises an artifact, bumping its version. Requires `write` on `artifact:<id>`. */
export async function reviseArtifact(
  transport: Transport,
  tenantId: string,
  artifactId: string,
  input: { title?: string; content?: string; metadata?: Record<string, unknown> | null },
): Promise<Artifact> {
  return transport.fetch<Artifact>(
    "POST",
    tenantPathFor(tenantId, `/artifacts/${artifactId}/versions`),
    input,
  );
}

/** Soft-hides an artifact (sets `archivedAt`). Requires `archive` on `artifact:<id>`. */
export async function archiveArtifact(
  transport: Transport,
  tenantId: string,
  artifactId: string,
): Promise<void> {
  await transport.fetch("POST", tenantPathFor(tenantId, `/artifacts/${artifactId}/archive`));
}
