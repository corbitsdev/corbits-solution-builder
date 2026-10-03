/**
 * A project's artifacts live in the project's own tenant (#29): every write
 * lands there, and the tenant -- not the `metadata.sb.projectId` label --
 * is what keeps one project's drafts out of another's. The label stays,
 * descriptive, on every record.
 *
 * A project opened before that was so still has artifacts in the workspace
 * tenant, labelled with its id. Those are read alongside the project's own
 * (`listProjectArtifacts`), and a read by id falls back to the workspace
 * when the project tenant does not hold it (`findArtifact`), so an existing
 * project keeps every draft it had. Nothing new is written there.
 */
import type { Transport } from "@intx/hub-client";
import { getArtifact, getArtifactVersion, listArtifacts, type Artifact, type ArtifactListItem } from "@solutions-builder/installer";
import { parentTenantOf } from "./project-tenants.ts";

function projectOf(entry: ArtifactListItem): string | undefined {
  const sb = (entry.metadata as { sb?: { projectId?: unknown } } | null)?.sb;
  return typeof sb?.projectId === "string" ? sb.projectId : undefined;
}

/**
 * Every artifact of `projectId`: the project tenant's own list, plus the
 * workspace's records still labelled with this project (older projects).
 * The workspace read is best-effort: a project with everything in its own
 * tenant loses nothing if the workspace list fails.
 */
export async function listProjectArtifacts(
  transport: Transport,
  projectId: string,
  filters: { kind?: string } = {},
): Promise<ArtifactListItem[]> {
  const [own, parentId] = await Promise.all([listArtifacts(transport, projectId, filters), parentTenantOf(transport, projectId)]);
  if (!parentId) return own;
  const legacy = await listArtifacts(transport, parentId, filters).catch(() => [] as ArtifactListItem[]);
  const seen = new Set(own.map((entry) => entry.id));
  return [...own, ...legacy.filter((entry) => projectOf(entry) === projectId && !seen.has(entry.id))];
}

export type FoundArtifact = { readonly artifact: Artifact; readonly tenantId: string };

/**
 * `artifactId` as `tenantId` holds it, else as `tenantId`'s parent does --
 * a project's older artifact still in the workspace. Null when neither has
 * it. The tenant it was found in is what a follow-up write must target.
 */
export async function findArtifact(
  transport: Transport,
  tenantId: string,
  artifactId: string,
  /** One version rather than the current one. */
  version?: number,
): Promise<FoundArtifact | null> {
  const read = (scope: string) =>
    version === undefined ? getArtifact(transport, scope, artifactId) : getArtifactVersion(transport, scope, artifactId, version);
  const own = await read(tenantId);
  if (own) return { artifact: own, tenantId };
  const parentId = await parentTenantOf(transport, tenantId).catch(() => null);
  if (!parentId) return null;
  const legacy = await read(parentId);
  return legacy ? { artifact: legacy, tenantId: parentId } : null;
}
