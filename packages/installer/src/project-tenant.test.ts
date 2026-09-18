import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import type { ProjectPolicy } from "./project-tenant.js";
import { updateProject } from "./project-tenant.js";

/**
 * Follows `signal-grants.test.ts`: a fake `Transport` serves the tenant
 * endpoints, so no module mock can leak into the neighbouring suites.
 */

type Row = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
};

const POLICY_A: ProjectPolicy = {
  costTolerancePercent: 10,
  costToleranceAbsolute: 50,
  audiences: [],
  audienceQuorum: 1,
  allowExternalProviders: false,
};
const POLICY_B: ProjectPolicy = { ...POLICY_A, audienceQuorum: 2 };

function seed(policyVersion: number, revision: number): Row {
  return {
    id: "tnt_test",
    name: "Test",
    config: {
      solutionsBuilder: {
        policy: POLICY_A,
        policyVersion,
        revision,
        archivedAt: null,
        deletedAt: null,
      },
    },
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  };
}

function fakeTransport(row: Row): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const pathname = path.split("?")[0] ?? path;
      if (method === "GET" && pathname === `/api/tenants/${row.id}`) return row as T;
      if (method === "PATCH" && pathname === `/api/tenants/${row.id}`) {
        const patch = body as { name?: string; config?: Record<string, unknown> };
        if (patch.name !== undefined) row.name = patch.name;
        if (patch.config !== undefined) row.config = patch.config;
        return row as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("updateProject policy versioning", () => {
  test("a policy write moves policyVersion and revision", async () => {
    const row = seed(1, 1);
    const record = await updateProject(fakeTransport(row), "tnt_test", { policy: POLICY_B });
    expect(record.policy).toEqual(POLICY_B);
    expect(record.policyVersion).toBe(2);
    expect(record.revision).toBe(2);
    const stored = row.config.solutionsBuilder as { policyVersion: number; revision: number };
    expect(stored.policyVersion).toBe(2);
    expect(stored.revision).toBe(2);
  });

  test("a non-policy write moves only the revision", async () => {
    const row = seed(3, 7);
    const record = await updateProject(fakeTransport(row), "tnt_test", { title: "Renamed" });
    expect(record.title).toBe("Renamed");
    expect(record.policyVersion).toBe(3);
    expect(record.revision).toBe(8);
  });
});
