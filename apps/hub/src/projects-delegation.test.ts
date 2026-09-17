import { describe, expect, test } from "bun:test";
import type { HubGrant } from "./hub-client.js";
import { delegationResource, type DelegationRecord, type DelegationStore, type ProjectPolicy } from "@solutions-builder/installer";
import { createProject, deleteProject, revokeProjectDelegations } from "./projects.js";

const POLICY: ProjectPolicy = {
  costTolerancePercent: 10,
  costToleranceAbsolute: 100,
  audiences: [],
  audienceQuorum: 0,
  allowExternalProviders: false,
};

function grant(id: string, credentialId: string): HubGrant {
  return {
    id,
    roleId: null,
    principalId: "principal-owner",
    resource: delegationResource(credentialId),
    action: "use",
    effect: "allow",
    origin: "invoker",
  };
}

/** The hub behind a fake: grants and consent records in memory, mints that can fail. */
function fakeStore(fail?: { mintFrom?: number; deleteGrants?: boolean }): DelegationStore & {
  grants: HubGrant[];
  records: Map<string, DelegationRecord>;
} {
  const grants: HubGrant[] = [];
  const records = new Map<string, DelegationRecord>();
  let minted = 0;
  return {
    grants,
    records,
    listDelegatableCredentials: async () => [
      { id: "cred-shared", principalId: null },
      { id: "cred-other", principalId: null },
    ],
    listChildGrants: async () => [...grants],
    ownerInChild: async () => "principal-owner",
    readRecord: async (projectId) => records.get(projectId) ?? null,
    writeRecord: async (projectId, record) => {
      records.set(projectId, record);
    },
    mintChildGrant: async (_projectId, input) => {
      minted += 1;
      if (fail?.mintFrom !== undefined && minted >= fail.mintFrom) {
        throw new Error("the hub dropped the mint");
      }
      const created = { ...input, id: `grant-${minted}`, roleId: null };
      grants.push(created);
      return created;
    },
    deleteChildGrant: async (_projectId, grantId) => {
      if (fail?.deleteGrants) throw new Error("the hub would not let go of the grant");
      const at = grants.findIndex((entry) => entry.id === grantId);
      if (at >= 0) grants.splice(at, 1);
    },
  };
}

/** Tenants the way listings see them: created rows minus the concealed ones. */
function fakeTenants() {
  const rows = new Map<string, { id: string; deletedAt: Date | null }>();
  let opened = 0;
  return {
    listable: () => [...rows.values()].filter((row) => !row.deletedAt),
    createRecord: async (input: { title: string; policy: ProjectPolicy }) => {
      void input;
      opened += 1;
      const row = { id: `project-${opened}`, deletedAt: null as Date | null };
      rows.set(row.id, row);
      return row;
    },
    concealRecord: async (projectId: string) => {
      rows.get(projectId)!.deletedAt = new Date();
    },
  };
}

describe("createProject rollback", () => {
  test("a delegation failure mid-creation leaves no listable tenant", async () => {
    const store = fakeStore({ mintFrom: 2 });
    const tenants = fakeTenants();
    await expect(
      createProject(
        {
          title: "Doomed workbench",
          policy: POLICY,
          owner: { principalId: "principal-owner", displayName: "Owner" },
          delegatedCredentialIds: ["cred-shared", "cred-other"],
        },
        { store, createRecord: tenants.createRecord, concealRecord: tenants.concealRecord },
      ),
    ).rejects.toThrow("the hub dropped the mint");
    expect(tenants.listable()).toEqual([]);
    expect(store.grants).toHaveLength(0);
  });
});

describe("deleteProject revocation", () => {
  test("a revocation failure surfaces and withholds the delete mark", async () => {
    const store = fakeStore({ deleteGrants: true });
    store.records.set("project-1", {
      mode: "chosen",
      credentialIds: ["cred-shared"],
      principalId: "principal-owner",
      grantedAt: new Date().toISOString(),
      grantIds: ["grant-1"],
    });
    store.grants.push(grant("grant-1", "cred-shared"));
    let marked = false;
    await expect(
      deleteProject("project-1", {
        store,
        markDeleted: async () => {
          marked = true;
        },
      }),
    ).rejects.toThrow("the hub would not let go of the grant");
    expect(marked).toBe(false);
    expect(store.grants).toHaveLength(1);
  });

  test("survivors stay revocable after the delete mark", async () => {
    const store = fakeStore();
    store.records.set("project-1", {
      mode: "chosen",
      credentialIds: ["cred-shared"],
      principalId: "principal-owner",
      grantedAt: new Date().toISOString(),
      grantIds: ["grant-1"],
    });
    store.grants.push(grant("grant-1", "cred-shared"));
    // The delete mark hides the project from every listing, but the tenant —
    // its record and its grants — is still there, so revocation goes through.
    const revoked = await revokeProjectDelegations("project-1", store);
    expect(revoked).toEqual(["cred-shared"]);
    expect(store.grants).toHaveLength(0);
  });
});
