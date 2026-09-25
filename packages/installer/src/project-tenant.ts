/**
 * A project is a tenant under the workspace.
 *
 * The hub owns the row: title is the tenant's name, and what the ledger needs
 * beside it — policy, revision, archive and delete marks — is the tenant's
 * config. Participants are principals holding roles in that tenant, so "may
 * this person approve here" is a question the hub's own evaluator answers.
 */
import type { Transport } from "@intx/hub-client";
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import {
  assignRole,
  createChildTenant,
  ensureRole,
  getTenant,
  listChildTenants,
  myPrincipalIn,
  patchTenant,
  type HubTenant,
} from "./hub.js";
import { InstallerError } from "./errors.js";
import { ensureAuthorityGrants } from "./authority-grants.js";

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
  /** What the owner consented to delegate into this tenant, for audit and revocation. */
  delegation?: DelegationRecord;
  /** CL-8899: which deployment an explicit "Switch model" chose, per stage
   *  (keyed by stage number as a string) -- see `StageModelSwitchRecord`. */
  modelSwitch?: Record<string, StageModelSwitchRecord>;
};

/** What the owner consented to, stored on the project tenant for audit. */
export type DelegationRecord = {
  mode: "chosen" | "default";
  credentialIds: string[];
  principalId: string;
  grantedAt: string;
  grantIds: string[];
};

/**
 * CL-8899 "Switch model": the deployment an explicit switch chose for one
 * stage, recorded durably on the project tenant's own config -- the same
 * read-modify-write `patchTenant` mechanism `writeDelegationRecord` already
 * uses, not a new hub route. Durable (survives a restart) and shared (every
 * window reads the same tenant), unlike a browser-local preference.
 *
 * `specialist-deploy.ts`'s deployment resolution prefers this over its
 * default oldest-live-wins pick ONLY while `deploymentId` is still live --
 * once the hub ends it (including a restart-driven replacement, which never
 * itself writes this record), resolution falls back to oldest-wins exactly
 * as before the switch ever happened, so a restart never "redirects" an
 * active session onto stale switch intent.
 */
export type StageModelSwitchRecord = {
  readonly deploymentId: string;
  /** The offering the switch targeted -- lets a repeat "switch to the same
   *  model" recognize it has nothing to do without a network round trip to
   *  the asset's own pin. */
  readonly offeringId: string;
  readonly switchedAt: string;
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
  const prior = existing?.[CONFIG_KEY] as StoredProject | undefined;
  const stored: StoredProject = {
    policy: record.policy,
    policyVersion: record.policyVersion,
    revision: record.revision,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
    ...(prior?.delegation !== undefined ? { delegation: prior.delegation } : {}),
    ...(prior?.modelSwitch !== undefined ? { modelSwitch: prior.modelSwitch } : {}),
  };
  return { ...(existing ?? {}), [CONFIG_KEY]: stored };
}

function notFound(what: string): InstallerError {
  return new InstallerError("conflict", `${what} was not found.`);
}

/** Opens the project tenant and gives the owner every human authority in it. */
export async function createProjectRecord(
  transport: Transport,
  workspaceTenantId: string,
  args: { title: string; policy: ProjectPolicy; slug: string },
): Promise<ProjectRecord> {
  const tenant = await createChildTenant(transport, workspaceTenantId, { name: args.title, slug: args.slug });
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
  await patchTenant(transport, tenant.id, { config: toConfig(record, tenant.config) });
  await installProjectAuthority(transport, tenant.id, args.policy);
  return record;
}

/** A live project, or null when it does not exist or was deleted. */
export async function readProject(transport: Transport, projectId: string): Promise<ProjectRecord | null> {
  const tenant = await getTenant(transport, projectId);
  const record = tenant ? fromTenant(tenant) : null;
  return record && !record.deletedAt ? record : null;
}

export async function requireProject(transport: Transport, projectId: string): Promise<ProjectRecord> {
  const record = await readProject(transport, projectId);
  if (!record) throw notFound("That project");
  return record;
}

/** The recorded consent on a project, or null when nothing was ever consented. */
export async function readDelegationRecord(
  transport: Transport,
  projectId: string,
): Promise<DelegationRecord | null> {
  const tenant = await getTenant(transport, projectId);
  if (!tenant) throw notFound("That project");
  return (tenant.config?.[CONFIG_KEY] as StoredProject | undefined)?.delegation ?? null;
}

/** Records consent on the project tenant; read-modify-write like every config change. */
export async function writeDelegationRecord(
  transport: Transport,
  projectId: string,
  record: DelegationRecord,
): Promise<void> {
  const tenant = await getTenant(transport, projectId);
  if (!tenant) throw notFound("That project");
  const stored = (tenant.config?.[CONFIG_KEY] as StoredProject | undefined) ?? null;
  if (!stored) throw notFound("That project");
  await patchTenant(transport, projectId, {
    config: { ...(tenant.config ?? {}), [CONFIG_KEY]: { ...stored, delegation: record } },
  });
}

/** The stage's explicitly-switched-to deployment, or null when the stage
 *  has never been switched (or the project has no config yet). */
export async function readStageSwitch(
  transport: Transport,
  projectId: string,
  stage: number,
): Promise<StageModelSwitchRecord | null> {
  const tenant = await getTenant(transport, projectId);
  const stored = tenant?.config?.[CONFIG_KEY] as StoredProject | undefined;
  return stored?.modelSwitch?.[String(stage)] ?? null;
}

/** Records an explicit switch's target; read-modify-write like every config
 *  change (`writeDelegationRecord`'s pattern) -- a plain last-write-wins on
 *  the tenant's config, which is fine here: `switchSpecialistDeployment`
 *  serializes callers per project+stage itself, so this is never raced from
 *  two switches at once within one process, and two processes racing here
 *  is no worse than two processes racing to deploy in the first place. */
export async function writeStageSwitch(
  transport: Transport,
  projectId: string,
  stage: number,
  record: StageModelSwitchRecord,
): Promise<void> {
  const tenant = await getTenant(transport, projectId);
  if (!tenant) throw notFound("That project");
  const stored = (tenant.config?.[CONFIG_KEY] as StoredProject | undefined) ?? null;
  if (!stored) throw notFound("That project");
  const modelSwitch = { ...(stored.modelSwitch ?? {}), [String(stage)]: record };
  await patchTenant(transport, projectId, {
    config: { ...(tenant.config ?? {}), [CONFIG_KEY]: { ...stored, modelSwitch } },
  });
}

/** Every live project under the workspace tenant, newest first. */
export async function listProjectRecords(
  transport: Transport,
  workspaceTenantId: string,
): Promise<ProjectRecord[]> {
  const rows = await listChildTenants(transport, workspaceTenantId);
  return rows
    .map((row) => fromTenant(row))
    .filter((record): record is ProjectRecord => record !== null && !record.deletedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Applies a change and moves the revision, which is what makes an expected
 * revision mean anything. A policy write moves `policyVersion` too: the
 * rendered lifecycle is built from the policy, and the host — which never
 * sees this write directly — tells a stakeholder change apart from any other
 * revision bump by it, and forgets the deployment it resolved. Read-modify-write
 * on the tenant's config: the host is the tenant's only writer, and the engine
 * serialises commands per key.
 */
export async function updateProject(
  transport: Transport,
  projectId: string,
  patch: Partial<Pick<ProjectRecord, "title" | "archivedAt" | "deletedAt" | "policy">>,
): Promise<ProjectRecord> {
  const tenant = await getTenant(transport, projectId);
  const current = tenant ? fromTenant(tenant) : null;
  if (!tenant || !current) throw notFound("That project");
  const next: ProjectRecord = {
    ...current,
    ...patch,
    ...(patch.policy !== undefined ? { policyVersion: current.policyVersion + 1 } : {}),
    revision: current.revision + 1,
  };
  const updated: HubTenant = await patchTenant(transport, projectId, {
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
 * `authority:<name>/hold` grant the evaluator answers for and the
 * `workflow-run:*` / `signal:<name>` grants for commands that name holds,
 * plus one role per audience. The owner holds every human authority.
 * Idempotent, so it also repairs a project opened before roles lived here.
 */
export async function installProjectAuthority(
  transport: Transport,
  projectId: string,
  policy: ProjectPolicy,
): Promise<void> {
  const owner = await myPrincipalIn(transport, projectId);
  if (!owner) {
    throw new InstallerError("internal_error", "The hub opened the project but the owner is not in it.");
  }
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    const role = await ensureRole(transport, projectId, name, ROLE_DESCRIPTIONS[name] ?? "");
    await ensureAuthorityGrants(transport, projectId, role.id, name);
    await assignRole(transport, projectId, owner, role.id);
  }
  for (const audience of policy.audiences) {
    const role = await ensureRole(
      transport,
      projectId,
      audienceRoleName(audience.name),
      `Audience "${audience.name}" on this project.`,
    );
    await assignRole(transport, projectId, owner, role.id);
  }
}
