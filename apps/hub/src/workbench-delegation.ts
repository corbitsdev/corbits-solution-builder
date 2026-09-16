/**
 * Delegation grants carry user-chosen parent credentials into a project tenant.
 *
 * A project tenant starts sealed: nothing the workspace holds is usable inside
 * it until the owner says so at creation. For every chosen credential this
 * mints `credential:<id>/use` on the owner's principal inside the child
 * tenant, so the platform's own single-tenant collection finds it with no
 * upstream change. The consent — the chosen set, or the explicit default of
 * none — is recorded on the project tenant beside the policy, which is what
 * makes the delegation auditable and revocable per workbench.
 */
import { HostError } from "./errors.js";
import {
  catalog,
  createPrincipalGrant,
  deleteGrant,
  listGrants,
  myPrincipalIn,
  type HubGrant,
} from "./hub-client.js";
import { readDelegationRecord, writeDelegationRecord, type DelegationRecord } from "./project-tenant.js";

export const DELEGATION_ACTION = "use";

export function delegationResource(credentialId: string): string {
  return `credential:${credentialId}`;
}

/** A credential the owner may delegate: tenant-owned, never personal. */
export type DelegatableCredential = { id: string; principalId: string | null };

export type DelegationStore = {
  listDelegatableCredentials(): Promise<DelegatableCredential[]>;
  listChildGrants(projectId: string): Promise<HubGrant[]>;
  ownerInChild(projectId: string): Promise<string | null>;
  readRecord(projectId: string): Promise<DelegationRecord | null>;
  writeRecord(projectId: string, record: DelegationRecord): Promise<void>;
  mintChildGrant(projectId: string, input: {
    principalId: string;
    resource: string;
    action: string;
    effect: "allow";
    origin: "invoker";
  }): Promise<HubGrant>;
  deleteChildGrant(projectId: string, grantId: string): Promise<void>;
};

/** The live store: the hub behind its own client, the tenant as the namespace. */
export function liveDelegationStore(): DelegationStore {
  return {
    listDelegatableCredentials: () => catalog.credentials(),
    listChildGrants: (projectId) => listGrants(projectId),
    ownerInChild: (projectId) => myPrincipalIn(projectId),
    readRecord: (projectId) => readDelegationRecord(projectId),
    writeRecord: (projectId, record) => writeDelegationRecord(projectId, record),
    mintChildGrant: (projectId, input) => createPrincipalGrant(input, projectId),
    deleteChildGrant: (projectId, grantId) => deleteGrant(grantId, projectId),
  };
}

/**
 * Settles what the creation payload consents to. Absent is the explicit
 * default of none — recorded, never silent. Unknown ids and personal
 * credentials fail closed before any tenant exists.
 */
export function resolveDelegationConsent(
  raw: string[] | undefined,
  available: DelegatableCredential[],
): { mode: "chosen" | "default"; credentialIds: string[] } {
  if (raw === undefined) return { mode: "default", credentialIds: [] };
  const credentialIds = [...new Set(raw)];
  const byId = new Map(available.map((credential) => [credential.id, credential]));
  for (const id of credentialIds) {
    const credential = byId.get(id);
    if (!credential) throw new HostError("validation_failed", `No credential with id "${id}".`);
    if (credential.principalId !== null) {
      throw new HostError(
        "validation_failed",
        `Credential "${id}" is personal to its owner and never crosses into a project.`,
      );
    }
  }
  return { mode: "chosen", credentialIds };
}

/** A delegation grant is this principal's allow on this credential's use. */
export function isDelegationGrant(grant: HubGrant, principalId: string, credentialId: string): boolean {
  return (
    grant.principalId === principalId &&
    grant.roleId === null &&
    grant.resource === delegationResource(credentialId) &&
    grant.action === DELEGATION_ACTION &&
    grant.effect === "allow"
  );
}

/** The chosen ids with no delegation grant yet: minting these is create-if-missing. */
export function missingDelegations(
  existing: HubGrant[],
  principalId: string,
  credentialIds: string[],
): string[] {
  return credentialIds.filter(
    (id) => !existing.some((grant) => isDelegationGrant(grant, principalId, id)),
  );
}

/**
 * Mints the missing `use` grants and returns every delegation grant for the
 * set. Origin `invoker`: the delegation flows from the owner who launches
 * runs here, which is what the trigger resolves invoker-source requirements
 * against. Running it twice mints nothing the second time.
 */
export async function ensureDelegationGrants(
  store: DelegationStore,
  args: { projectId: string; principalId: string; credentialIds: string[] },
): Promise<HubGrant[]> {
  const existing = await store.listChildGrants(args.projectId);
  const missing = missingDelegations(existing, args.principalId, args.credentialIds);
  const minted = await Promise.all(
    missing.map((credentialId) =>
      store.mintChildGrant(args.projectId, {
        principalId: args.principalId,
        resource: delegationResource(credentialId),
        action: DELEGATION_ACTION,
        effect: "allow",
        origin: "invoker",
      }),
    ),
  );
  return [...existing, ...minted].filter((grant) =>
    args.credentialIds.some((id) => isDelegationGrant(grant, args.principalId, id)),
  );
}

/**
 * Deletes the delegation grants for the set — or every delegation-shaped
 * grant on the principal when no set is given — and returns the revoked
 * credential ids. Only exact-match allow grants go; denies, role grants, and
 * other principals are untouched.
 */
export async function revokeDelegationGrants(
  store: DelegationStore,
  args: { projectId: string; principalId: string; credentialIds?: string[] },
): Promise<string[]> {
  const existing = await store.listChildGrants(args.projectId);
  const condemned = existing.filter(
    (grant) =>
      grant.principalId === args.principalId &&
      grant.roleId === null &&
      grant.action === DELEGATION_ACTION &&
      grant.effect === "allow" &&
      grant.resource.startsWith("credential:") &&
      (args.credentialIds === undefined ||
        args.credentialIds.some((id) => grant.resource === delegationResource(id))),
  );
  await Promise.all(condemned.map((grant) => store.deleteChildGrant(args.projectId, grant.id)));
  return [...new Set(condemned.map((grant) => grant.resource.slice("credential:".length)))];
}

/**
 * The full creation step: settle consent, mint into the child tenant, record
 * it on the project tenant. Validation runs before the caller opens the
 * tenant, so a refused set never leaves a half-created project behind.
 */
export async function delegateAtCreation(
  store: DelegationStore,
  args: { projectId: string; delegatedCredentialIds?: string[] | undefined },
): Promise<DelegationRecord> {
  const available = await store.listDelegatableCredentials();
  const consent = resolveDelegationConsent(args.delegatedCredentialIds, available);
  const principalId = await store.ownerInChild(args.projectId);
  if (!principalId) {
    throw new HostError("internal_error", "The hub opened the project but the owner is not in it.");
  }
  const grants = await ensureDelegationGrants(store, {
    projectId: args.projectId,
    principalId,
    credentialIds: consent.credentialIds,
  });
  const record: DelegationRecord = {
    ...consent,
    principalId,
    grantedAt: new Date().toISOString(),
    grantIds: grants.map((grant) => grant.id),
  };
  await store.writeRecord(args.projectId, record);
  return record;
}

/** Adds to the consented set after creation; idempotent like the creation step. */
export async function delegateMore(
  store: DelegationStore,
  args: { projectId: string; delegatedCredentialIds: string[] },
): Promise<DelegationRecord> {
  const prior = (await store.readRecord(args.projectId)) ?? {
    mode: "default" as const,
    credentialIds: [],
    principalId: "",
    grantedAt: new Date(0).toISOString(),
    grantIds: [],
  };
  const available = await store.listDelegatableCredentials();
  const consent = resolveDelegationConsent(
    [...prior.credentialIds, ...args.delegatedCredentialIds],
    available,
  );
  const principalId = await store.ownerInChild(args.projectId);
  if (!principalId) {
    throw new HostError("internal_error", "The owner is not in that project.");
  }
  const grants = await ensureDelegationGrants(store, {
    projectId: args.projectId,
    principalId,
    credentialIds: consent.credentialIds,
  });
  const record: DelegationRecord = {
    mode: "chosen",
    credentialIds: consent.credentialIds,
    principalId,
    grantedAt: new Date().toISOString(),
    grantIds: grants.map((grant) => grant.id),
  };
  await store.writeRecord(args.projectId, record);
  return record;
}

/** What the owner consented to plus the live grants carrying it: the audit view. */
export async function delegationAudit(
  store: DelegationStore,
  projectId: string,
): Promise<{ consent: DelegationRecord | null; grants: HubGrant[] }> {
  const consent = await store.readRecord(projectId);
  if (!consent) return { consent: null, grants: [] };
  const existing = await store.listChildGrants(projectId);
  const grants = existing.filter((grant) =>
    consent.credentialIds.some((id) => isDelegationGrant(grant, consent.principalId, id)),
  );
  return { consent, grants };
}

/** Revokes every recorded delegation on a workbench and clears its record. */
export async function revokeAllDelegations(
  store: DelegationStore,
  projectId: string,
): Promise<string[]> {
  const prior = await store.readRecord(projectId);
  if (!prior) return [];
  const revoked = await revokeDelegationGrants(store, {
    projectId,
    principalId: prior.principalId,
    credentialIds: prior.credentialIds,
  });
  await store.writeRecord(projectId, {
    mode: "default",
    credentialIds: [],
    principalId: prior.principalId,
    grantedAt: new Date().toISOString(),
    grantIds: [],
  });
  return revoked;
}
