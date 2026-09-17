import { describe, expect, test } from "bun:test";
import {
  SPECIALIST_PRINCIPAL_ID,
  ensurePrincipal,
  ensureSpecialistPrincipal,
  ensureUserPrincipal,
  type PrincipalIo,
  type PrincipalSeed,
} from "./hub-client.js";

const SEED: PrincipalSeed = {
  id: "p_test",
  tenantId: "t_test",
  kind: "user",
  refId: "p_test",
  status: "active",
};

function stubIo(existing: Set<string>, created: PrincipalSeed[], raceOnCreate = false): PrincipalIo {
  return {
    exists: async (id) => existing.has(id),
    create: async (seed) => {
      created.push(seed);
      return raceOnCreate ? null : { ...seed };
    },
  };
}

describe("ensurePrincipal", () => {
  test("an existing id writes nothing", async () => {
    const created: PrincipalSeed[] = [];
    await ensurePrincipal(SEED, stubIo(new Set([SEED.id]), created));
    expect(created).toEqual([]);
  });

  test("a missing id creates the seed", async () => {
    const created: PrincipalSeed[] = [];
    await ensurePrincipal(SEED, stubIo(new Set(), created));
    expect(created).toEqual([SEED]);
  });

  test("a lost race on create still resolves", async () => {
    const created: PrincipalSeed[] = [];
    await ensurePrincipal(SEED, stubIo(new Set(), created, true));
    expect(created).toEqual([SEED]);
  });
});

describe("ensureSpecialistPrincipal", () => {
  test("seeds the workflow identity for the tenant", async () => {
    const created: PrincipalSeed[] = [];
    await ensureSpecialistPrincipal("t_acme", stubIo(new Set(), created));
    expect(created).toEqual([
      {
        id: SPECIALIST_PRINCIPAL_ID,
        tenantId: "t_acme",
        kind: "workflow",
        refId: "solutions-builder.specialist",
        status: "active",
      },
    ]);
  });

  test("a second call for the same tenant writes nothing", async () => {
    const created: PrincipalSeed[] = [];
    const existing = new Set([SPECIALIST_PRINCIPAL_ID]);
    await ensureSpecialistPrincipal("t_acme", stubIo(existing, created));
    expect(created).toEqual([]);
  });
});

describe("ensureUserPrincipal", () => {
  test("seeds a user row keyed to the principal id", async () => {
    const created: PrincipalSeed[] = [];
    await ensureUserPrincipal("t_acme", "p_host", stubIo(new Set(), created));
    expect(created).toEqual([
      { id: "p_host", tenantId: "t_acme", kind: "user", refId: "p_host", status: "active" },
    ]);
  });

  test("a real user principal is untouched", async () => {
    const created: PrincipalSeed[] = [];
    await ensureUserPrincipal("t_acme", "p_existing_user", stubIo(new Set(["p_existing_user"]), created));
    expect(created).toEqual([]);
  });
});
