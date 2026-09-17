/**
 * Credential delegation on a project tenant, through the hub's own HTTP API.
 *
 * Consent lives on the tenant's `solutionsBuilder` config; grants are
 * `credential:<id>/use` on the owner's principal in the child tenant. The
 * installer package owns the same operations for the client; this is the
 * host's loopback API talking to the same rows.
 */
import { catalog, createPrincipalGrant, deleteGrant, listGrants, myPrincipalIn, type HubGrant } from "./hub-client.js";
import { HostError } from "./errors.js";
import {
  readDelegationRecord,
  writeDelegationRecord,
  type DelegationRecord,
} from "./project-records.js";

export type { DelegationRecord };

export const DELEGATION_ACTION = "use";

export function delegationResource(credentialId: string): string {
  return `credential:${credentialId}`;
}

export type DelegatableCredential = { id: string; principalId: string | null };

export type DelegationStore = {
  listDelegatableCredentials(): Promise<DelegatableCredential[]>;
  listChildGrants(projectId: string): Promise<HubGrant[]>;
  ownerInChild(projectId: string): Promise<string | null>;
  readRecord(projectId: string): Promise<DelegationRecord | null>;
  writeRecord(projectId: string, record: DelegationRecord): Promise<void>;
  mintChildGrant(
    projectId: string,
    input: {
      principalId: string;
      resource: string;
      action: string;
      effect: "allow";
      origin: "invoker";
    },
  ): Promise<HubGrant>;
  deleteChildGrant(projectId: string, grantId: string): Promise<void>;
};

export function liveDelegationStore(): DelegationStore {
  return {
    listDelegatableCredentials: async () =>
      (await catalog.credentials()).map((credential) => ({
        id: credential.id,
        principalId: credential.principalId,
      })),
    listChildGrants: (projectId) => listGrants(projectId),
    ownerInChild: (projectId) => myPrincipalIn(projectId),
    readRecord: (projectId) => readDelegationRecord(projectId),
    writeRecord: (projectId, record) => writeDelegationRecord(projectId, record),
    mintChildGrant: (projectId, input) => createPrincipalGrant(input, projectId),
    deleteChildGrant: (projectId, grantId) => deleteGrant(grantId, projectId),
  };
}

export type DelegationConsent = { mode: "chosen" | "default"; credentialIds: string[] };

export function resolveDelegationConsent(
  raw: string[] | undefined,
  available: DelegatableCredential[],
): DelegationConsent {
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

export function isDelegationGrant(grant: HubGrant, principalId: string, credentialId: string): boolean {
  return (
    grant.principalId === principalId &&
    grant.roleId === null &&
    grant.resource === delegationResource(credentialId) &&
    grant.action === DELEGATION_ACTION &&
    grant.effect === "allow"
  );
}

export function missingDelegations(
  existing: HubGrant[],
  principalId: string,
  credentialIds: string[],
): string[] {
  return credentialIds.filter((id) => !existing.some((grant) => isDelegationGrant(grant, principalId, id)));
}

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

export async function delegateAtCreation(
  store: DelegationStore,
  args: {
    projectId: string;
    delegatedCredentialIds?: string[] | undefined;
    consent?: DelegationConsent | undefined;
  },
): Promise<DelegationRecord> {
  const consent =
    args.consent ??
    resolveDelegationConsent(args.delegatedCredentialIds, await store.listDelegatableCredentials());
  const principalId = await store.ownerInChild(args.projectId);
  if (!principalId) {
    throw new HostError("internal_error", "The hub opened the project but the owner is not in it.");
  }
  await store.writeRecord(args.projectId, {
    ...consent,
    principalId,
    grantedAt: new Date().toISOString(),
    grantIds: [],
  });
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
  const consent = resolveDelegationConsent([...prior.credentialIds, ...args.delegatedCredentialIds], available);
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

export async function revokeAllDelegations(store: DelegationStore, projectId: string): Promise<string[]> {
  const prior = await store.readRecord(projectId);
  if (!prior) return [];
  const revoked = await revokeDelegationGrants(store, {
    projectId,
    principalId: prior.principalId,
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
