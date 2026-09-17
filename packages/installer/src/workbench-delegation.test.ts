import { describe, expect, test } from "bun:test";
import { InstallerError } from "./errors.js";
import type { HubGrant } from "./hub.js";
import type { DelegationRecord } from "./project-tenant.js";
import {
  delegateAtCreation,
  delegateMore,
  delegationAudit,
  delegationResource,
  ensureDelegationGrants,
  isDelegationGrant,
  missingDelegations,
  resolveDelegationConsent,
  revokeAllDelegations,
  revokeDelegationGrants,
  type DelegatableCredential,
  type DelegationStore,
} from "./workbench-delegation.js";

const AVAILABLE: DelegatableCredential[] = [
  { id: "cred-shared", principalId: null },
  { id: "cred-other", principalId: null },
  { id: "cred-personal", principalId: "principal-someone" },
];

function grant(overrides: Partial<HubGrant> & { id: string }): HubGrant {
  return {
    roleId: null,
    principalId: "principal-owner",
    resource: delegationResource("cred-shared"),
    action: "use",
    effect: "allow",
    origin: "invoker",
    ...overrides,
  };
}

/** The hub behind a fake: grants and consent records in memory. */
function fakeStore(): DelegationStore & { grants: HubGrant[]; records: Map<string, DelegationRecord> } {
  const grants: HubGrant[] = [];
  const records = new Map<string, DelegationRecord>();
  let minted = 0;
  return {
    grants,
    records,
    listDelegatableCredentials: async () => AVAILABLE,
    listChildGrants: async () => [...grants],
    ownerInChild: async () => "principal-owner",
    readRecord: async (projectId) => records.get(projectId) ?? null,
    writeRecord: async (projectId, record) => {
      records.set(projectId, record);
    },
    mintChildGrant: async (_projectId, input) => {
      minted += 1;
      const created = { ...input, id: `grant-${minted}`, roleId: null };
      grants.push(created);
      return created;
    },
    deleteChildGrant: async (_projectId, grantId) => {
      const at = grants.findIndex((entry) => entry.id === grantId);
      if (at >= 0) grants.splice(at, 1);
    },
  };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof InstallerError) return cause.code;
    throw cause;
  }
  throw new Error("expected an InstallerError");
}

describe("resolveDelegationConsent", () => {
  test("absent consent is the explicit default of none", () => {
    expect(resolveDelegationConsent(undefined, AVAILABLE)).toEqual({ mode: "default", credentialIds: [] });
  });

  test("chosen ids are deduped and pass through", () => {
    expect(resolveDelegationConsent(["cred-shared", "cred-shared", "cred-other"], AVAILABLE)).toEqual({
      mode: "chosen",
      credentialIds: ["cred-shared", "cred-other"],
    });
  });

  test("an unknown id fails closed", async () => {
    expect(await codeOf(async () => resolveDelegationConsent(["cred-missing"], AVAILABLE))).toBe(
      "validation_failed",
    );
  });

  test("a personal credential never crosses", async () => {
    expect(await codeOf(async () => resolveDelegationConsent(["cred-personal"], AVAILABLE))).toBe(
      "validation_failed",
    );
  });
});

describe("ensureDelegationGrants", () => {
  test("mints create-if-missing and the second run is a no-op", async () => {
    const store = fakeStore();
    const first = await ensureDelegationGrants(store, {
      projectId: "project-a",
      principalId: "principal-owner",
      credentialIds: ["cred-shared", "cred-other"],
    });
    expect(first).toHaveLength(2);
    expect(store.grants).toHaveLength(2);

    const second = await ensureDelegationGrants(store, {
      projectId: "project-a",
      principalId: "principal-owner",
      credentialIds: ["cred-shared", "cred-other"],
    });
    expect(second).toHaveLength(2);
    expect(store.grants).toHaveLength(2);
    expect(second.map((entry) => entry.id).sort()).toEqual(first.map((entry) => entry.id).sort());
  });

  test("reuses a pre-existing grant and mints only the gap", async () => {
    const store = fakeStore();
    store.grants.push(grant({ id: "grant-prior" }));
    const ensured = await ensureDelegationGrants(store, {
      projectId: "project-a",
      principalId: "principal-owner",
      credentialIds: ["cred-shared", "cred-other"],
    });
    expect(ensured.map((entry) => entry.id).sort()).toEqual(["grant-1", "grant-prior"]);
    expect(store.grants).toHaveLength(2);
  });

  test("missingDelegations ignores other principals, denies and role grants", () => {
    const existing = [
      grant({ id: "g-other-principal", principalId: "principal-stranger" }),
      grant({ id: "g-deny", effect: "deny" }),
      grant({ id: "g-role", roleId: "role-x", principalId: null }),
      grant({ id: "g-other-action", action: "read" }),
    ];
    expect(missingDelegations(existing, "principal-owner", ["cred-shared"])).toEqual(["cred-shared"]);
    expect(isDelegationGrant(grant({ id: "g-ok" }), "principal-owner", "cred-shared")).toBe(true);
  });
});

describe("revokeDelegationGrants", () => {
  test("deletes only the delegation-shaped allows", async () => {
    const store = fakeStore();
    store.grants.push(
      grant({ id: "g-revoke", resource: delegationResource("cred-shared") }),
      grant({ id: "g-keep-deny", effect: "deny" }),
      grant({ id: "g-keep-role", roleId: "role-x", principalId: null }),
      grant({ id: "g-keep-stranger", principalId: "principal-stranger" }),
      grant({ id: "g-keep-other-cred", resource: delegationResource("cred-other") }),
    );
    const revoked = await revokeDelegationGrants(store, {
      projectId: "project-a",
      principalId: "principal-owner",
      credentialIds: ["cred-shared"],
    });
    expect(revoked).toEqual(["cred-shared"]);
    expect(store.grants.map((entry) => entry.id).sort()).toEqual([
      "g-keep-deny",
      "g-keep-other-cred",
      "g-keep-role",
      "g-keep-stranger",
    ]);
  });

  test("revoking an empty set touches nothing", async () => {
    const store = fakeStore();
    store.grants.push(grant({ id: "g-stays" }));
    expect(
      await revokeDelegationGrants(store, { projectId: "project-a", principalId: "principal-owner", credentialIds: [] }),
    ).toEqual([]);
    expect(store.grants).toHaveLength(1);
  });
});

describe("creation, audit and revocation", () => {
  test("creation mints and records the chosen set", async () => {
    const store = fakeStore();
    const record = await delegateAtCreation(store, {
      projectId: "project-a",
      delegatedCredentialIds: ["cred-shared"],
    });
    expect(record.mode).toBe("chosen");
    expect(record.credentialIds).toEqual(["cred-shared"]);
    expect(record.principalId).toBe("principal-owner");
    expect(record.grantIds).toHaveLength(1);
    expect(store.records.get("project-a")).toEqual(record);
  });

  test("creation without a set records the default and mints nothing", async () => {
    const store = fakeStore();
    const record = await delegateAtCreation(store, { projectId: "project-a" });
    expect(record).toMatchObject({ mode: "default", credentialIds: [], grantIds: [] });
    expect(store.grants).toHaveLength(0);
  });

  test("adding consent later merges idempotently", async () => {
    const store = fakeStore();
    await delegateAtCreation(store, { projectId: "project-a", delegatedCredentialIds: ["cred-shared"] });
    const record = await delegateMore(store, {
      projectId: "project-a",
      delegatedCredentialIds: ["cred-shared", "cred-other"],
    });
    expect(record.credentialIds).toEqual(["cred-shared", "cred-other"]);
    expect(record.grantIds).toHaveLength(2);
    expect(store.grants).toHaveLength(2);
  });

  test("audit shows the consent and its live grants", async () => {
    const store = fakeStore();
    await delegateAtCreation(store, { projectId: "project-a", delegatedCredentialIds: ["cred-shared"] });
    const audit = await delegationAudit(store, "project-a");
    expect(audit.consent?.credentialIds).toEqual(["cred-shared"]);
    expect(audit.grants).toHaveLength(1);
    expect(await delegationAudit(store, "project-never")).toEqual({ consent: null, grants: [] });
  });

  test("revocation deletes the grants and clears the record", async () => {
    const store = fakeStore();
    await delegateAtCreation(store, {
      projectId: "project-a",
      delegatedCredentialIds: ["cred-shared", "cred-other"],
    });
    const revoked = await revokeAllDelegations(store, "project-a");
    expect(revoked.sort()).toEqual(["cred-other", "cred-shared"]);
    expect(store.grants).toHaveLength(0);
    expect(store.records.get("project-a")).toMatchObject({ mode: "default", credentialIds: [] });
    expect(await revokeAllDelegations(store, "project-never")).toEqual([]);
  });

  test("default denies, one chosen credential allows, revoke denies again", async () => {
    const store = fakeStore();
    const created = await delegateAtCreation(store, { projectId: "project-a" });
    expect(created.mode).toBe("default");
    expect(created.credentialIds).toEqual([]);
    expect(store.grants).toHaveLength(0);

    const added = await delegateMore(store, {
      projectId: "project-a",
      delegatedCredentialIds: ["cred-shared"],
    });
    expect(added.mode).toBe("chosen");
    expect(added.credentialIds).toEqual(["cred-shared"]);
    expect(store.grants).toHaveLength(1);
    expect(isDelegationGrant(store.grants[0]!, "principal-owner", "cred-shared")).toBe(true);

    const revoked = await revokeAllDelegations(store, "project-a");
    expect(revoked).toEqual(["cred-shared"]);
    expect(store.grants).toHaveLength(0);
    expect(store.records.get("project-a")).toMatchObject({ mode: "default", credentialIds: [] });
  });

  test("a mint that dies midway still leaves a revocable record", async () => {
    const store = fakeStore();
    let mints = 0;
    const mint = store.mintChildGrant;
    store.mintChildGrant = async (projectId, input) => {
      mints += 1;
      if (mints > 1) throw new Error("the hub dropped the second mint");
      return mint(projectId, input);
    };
    await expect(
      delegateAtCreation(store, {
        projectId: "project-a",
        delegatedCredentialIds: ["cred-shared", "cred-other"],
      }),
    ).rejects.toThrow("the hub dropped the second mint");
    expect(store.grants).toHaveLength(1);
    expect(store.records.get("project-a")?.credentialIds).toEqual(["cred-shared", "cred-other"]);
    const revoked = await revokeAllDelegations(store, "project-a");
    expect(revoked).toEqual(["cred-shared"]);
    expect(store.grants).toHaveLength(0);
  });

  test("a record write that fails after minting still leaves revocable grants", async () => {
    const store = fakeStore();
    let writes = 0;
    const write = store.writeRecord;
    store.writeRecord = async (projectId, record) => {
      writes += 1;
      if (writes === 2) throw new Error("the tenant config would not stick");
      return write(projectId, record);
    };
    await expect(
      delegateAtCreation(store, {
        projectId: "project-a",
        delegatedCredentialIds: ["cred-shared"],
      }),
    ).rejects.toThrow("the tenant config would not stick");
    expect(store.grants).toHaveLength(1);
    const revoked = await revokeAllDelegations(store, "project-a");
    expect(revoked).toEqual(["cred-shared"]);
    expect(store.grants).toHaveLength(0);
  });
});
