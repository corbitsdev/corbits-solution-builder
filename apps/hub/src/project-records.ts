/**
 * Project records as the hub sees them: a child tenant plus its
 * `solutionsBuilder` config.
 *
 * The installer package writes this shape when the client (or a smoke) creates
 * a project. The hub never imports that package; it reads and patches the same
 * tenant config over `hub-client.ts`.
 */
import { notFound } from "./errors.js";
import {
  createChildTenant,
  getTenant,
  listChildTenants,
  patchTenant,
  tenantId,
  type HubTenant,
} from "./hub-client.js";
import { newId } from "./ids.js";
import type { Authority } from "@solutions-builder/app/ledger";

export type ProjectPolicy = {
  costTolerancePercent: number;
  costToleranceAbsolute: number;
  audiences: { name: string; role: Authority }[];
  audienceQuorum: number;
  allowExternalProviders: boolean;
};

export type ProjectRecord = {
  id: string;
  title: string;
  policy: ProjectPolicy;
  policyVersion: number;
  revision: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
};

/** What the client's own delegation writes (over the installer) store here; the host only preserves it on rewrite. */
type DelegationRecord = {
  mode: "chosen" | "default";
  credentialIds: string[];
  principalId: string;
  grantedAt: string;
  grantIds: string[];
};

const CONFIG_KEY = "solutionsBuilder";

type StoredProject = {
  policy: ProjectPolicy;
  policyVersion: number;
  revision: number;
  archivedAt: string | null;
  deletedAt: string | null;
  delegation?: DelegationRecord;
};

/** The stored config on a tenant row, or null when this tenant is not a project. */
export function projectRecordFromTenant(row: {
  id: string;
  name: string;
  config?: Record<string, unknown> | null;
  createdAt: string | Date;
}): ProjectRecord | null {
  const stored = row.config?.[CONFIG_KEY] as StoredProject | undefined;
  if (!stored) return null;
  return {
    id: row.id,
    title: row.name,
    policy: stored.policy,
    policyVersion: stored.policyVersion,
    revision: stored.revision,
    archivedAt: stored.archivedAt ? new Date(stored.archivedAt) : null,
    deletedAt: stored.deletedAt ? new Date(stored.deletedAt) : null,
    createdAt: new Date(row.createdAt),
  };
}

function toConfig(record: ProjectRecord, existing: Record<string, unknown> | undefined) {
  const prior = existing?.[CONFIG_KEY] as StoredProject | undefined;
  const stored: StoredProject = {
    policy: record.policy,
    policyVersion: record.policyVersion,
    revision: record.revision,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
    ...(prior?.delegation !== undefined ? { delegation: prior.delegation } : {}),
  };
  return { ...(existing ?? {}), [CONFIG_KEY]: stored };
}

/** Opens the project tenant and writes its config. Authority and lifecycle stay the installer's. */
export async function createProjectRecord(args: { title: string; policy: ProjectPolicy }): Promise<ProjectRecord> {
  const tenant = await createChildTenant({ name: args.title, slug: newId.projectSlug() });
  const record: ProjectRecord = {
    id: tenant.id,
    title: tenant.name,
    policy: args.policy,
    policyVersion: 1,
    revision: 1,
    archivedAt: null,
    deletedAt: null,
    createdAt: new Date(tenant.createdAt),
  };
  await patchTenant(tenant.id, { config: toConfig(record, tenant.config) });
  return record;
}

/** A live project, or null when it does not exist or was deleted. */
export async function readProject(projectId: string): Promise<ProjectRecord | null> {
  const tenant = await getTenant(projectId);
  const record = tenant ? projectRecordFromTenant(tenant) : null;
  return record && !record.deletedAt ? record : null;
}

export async function requireProject(projectId: string): Promise<ProjectRecord> {
  const record = await readProject(projectId);
  if (!record) throw notFound("That project");
  return record;
}

/** Every live project under the workspace tenant, newest first. */
export async function listProjectRecords(): Promise<ProjectRecord[]> {
  const rows: HubTenant[] = await listChildTenants(tenantId());
  return rows
    .map((row) => projectRecordFromTenant(row))
    .filter((record): record is ProjectRecord => record !== null && !record.deletedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Applies a change and moves the revision. Read-modify-write on the tenant's
 * config: the host is the tenant's only writer, and the engine serialises
 * commands per key.
 */
export async function updateProject(
  projectId: string,
  patch: Partial<Pick<ProjectRecord, "title" | "archivedAt" | "deletedAt" | "policy">>,
): Promise<ProjectRecord> {
  const tenant = await getTenant(projectId);
  const current = tenant ? projectRecordFromTenant(tenant) : null;
  if (!tenant || !current) throw notFound("That project");
  const next: ProjectRecord = { ...current, ...patch, revision: current.revision + 1 };
  const updated = await patchTenant(projectId, {
    ...(patch.title !== undefined ? { name: patch.title } : {}),
    config: toConfig(next, tenant.config),
  });
  return projectRecordFromTenant(updated) ?? next;
}
