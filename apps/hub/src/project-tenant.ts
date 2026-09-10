/**
 * A project is a tenant under the workspace.
 *
 * The hub owns the row: title is the tenant's name, and what the ledger needs
 * beside it — policy, revision, archive and delete marks — is the tenant's
 * config. Participants are principals holding roles in that tenant, so "may
 * this person approve here" is a question the hub's own evaluator answers.
 */
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import {
  assignRole,
  createChildTenant,
  ensureRole,
  ensureRoleGrant,
  getTenant,
  myPrincipalIn,
  patchTenant,
  tenantId,
  type HubTenant,
} from "./hub-client.js";
import { listChildTenants } from "./hub-gaps.js";
import { HostError, notFound } from "./errors.js";
import { newId } from "./ids.js";

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
  /** Optimistic concurrency for existing-project mutations. */
  revision: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
};

const CONFIG_KEY = "solutionsBuilder";

type StoredProject = {
  policy: ProjectPolicy;
  policyVersion: number;
  revision: number;
  archivedAt: string | null;
  deletedAt: string | null;
};

function fromTenant(row: {
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
  const stored: StoredProject = {
    policy: record.policy,
    policyVersion: record.policyVersion,
    revision: record.revision,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
  };
  return { ...(existing ?? {}), [CONFIG_KEY]: stored };
}

/** Opens the project tenant and gives the owner every human authority in it. */
export async function createProjectRecord(args: {
  title: string;
  policy: ProjectPolicy;
}): Promise<ProjectRecord> {
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
  await installProjectAuthority(tenant.id, args.policy);
  return record;
}

/** A live project, or null when it does not exist or was deleted. */
export async function readProject(projectId: string): Promise<ProjectRecord | null> {
  const tenant = await getTenant(projectId);
  const record = tenant ? fromTenant(tenant) : null;
  return record && !record.deletedAt ? record : null;
}

export async function requireProject(projectId: string): Promise<ProjectRecord> {
  const record = await readProject(projectId);
  if (!record) throw notFound("That project");
  return record;
}

/** Every live project, newest first. */
export async function listProjectRecords(): Promise<ProjectRecord[]> {
  const rows = await listChildTenants(tenantId());
  return rows
    .map((row) => fromTenant(row))
    .filter((record): record is ProjectRecord => record !== null && !record.deletedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Applies a change and moves the revision, which is what makes an expected
 * revision mean anything. Read-modify-write on the tenant's config: the host
 * is the tenant's only writer, and the engine serialises commands per key.
 */
export async function updateProject(
  projectId: string,
  patch: Partial<Pick<ProjectRecord, "title" | "archivedAt" | "deletedAt" | "policy">>,
): Promise<ProjectRecord> {
  const tenant = await getTenant(projectId);
  const current = tenant ? fromTenant(tenant) : null;
  if (!tenant || !current) throw notFound("That project");
  const next: ProjectRecord = { ...current, ...patch, revision: current.revision + 1 };
  const updated: HubTenant = await patchTenant(projectId, {
    ...(patch.title !== undefined ? { name: patch.title } : {}),
    config: toConfig(next, tenant.config),
  });
  return fromTenant(updated) ?? next;
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  project_owner: "Opens a project, approves stages and accepts delivery.",
  budget_approver: "Approves a firm estimate before any spend is committed.",
  technical_approver: "Approves a plan on technical grounds.",
  audience_member: "Records a proceed, revise or reject on an audience package.",
  builder_operator: "Answers a build's questions and decides its permissions.",
  delivery_recipient: "Accepts or rejects the delivered software.",
};

export function audienceRoleName(audience: string): string {
  return `audience:${audience}`;
}

/**
 * The ledger's authorities as roles in the project tenant, each with the
 * `authority:<name>/hold` grant the evaluator answers for, plus one role per
 * audience. The owner holds every human authority. Idempotent, so it also
 * repairs a project opened before roles lived here.
 */
export async function installProjectAuthority(
  projectId: string,
  policy: ProjectPolicy,
): Promise<void> {
  const owner = await myPrincipalIn(projectId);
  if (!owner) {
    throw new HostError("internal_error", "The hub opened the project but the owner is not in it.");
  }
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    const role = await ensureRole(name, ROLE_DESCRIPTIONS[name] ?? "", projectId);
    await ensureRoleGrant(
      { roleId: role.id, resource: `authority:${name}`, action: "hold", effect: "allow", origin: "role" },
      projectId,
    );
    await assignRole(owner, role.id, projectId);
  }
  for (const audience of policy.audiences) {
    const role = await ensureRole(
      audienceRoleName(audience.name),
      `Audience "${audience.name}" on this project.`,
      projectId,
    );
    await assignRole(owner, role.id, projectId);
  }
}
