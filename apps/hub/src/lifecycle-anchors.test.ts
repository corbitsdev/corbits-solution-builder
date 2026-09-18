import { describe, expect, mock, test } from "bun:test";

/**
 * The anchor a project resolves to must not survive an installer stakeholder
 * write: that write lands as a `policyVersion` bump this process never sees
 * directly, so reuse checks the version and resolves again on mismatch.
 */

type Fixture = {
  tenant: Record<string, unknown> | null;
  tenantThrows: boolean;
  deployments: { id: string; definitionAssetId: string; status: string; provisionerBindingFingerprint: string | null }[];
  deploymentsCalls: number;
};

const fixtures = new Map<string, Fixture>();

function seed(projectId: string): Fixture {
  const assetId = `asset-for-${projectId}`;
  const fixture: Fixture = {
    tenant: {
      id: projectId,
      name: projectId,
      config: {
        solutionsBuilder: {
          policy: {
            costTolerancePercent: 10,
            costToleranceAbsolute: 50,
            audiences: [],
            audienceQuorum: 1,
            allowExternalProviders: false,
          },
          policyVersion: 1,
          revision: 1,
          archivedAt: null,
          deletedAt: null,
        },
      },
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    },
    tenantThrows: false,
    deployments: [{ id: `dep-${projectId}-1`, definitionAssetId: assetId, status: "active", provisionerBindingFingerprint: null }],
    deploymentsCalls: 0,
  };
  fixtures.set(projectId, fixture);
  return fixture;
}

function assetName(projectId: string): string {
  return `solutions-builder-project-lifecycle-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

mock.module("./hub-client.js", () => ({
  assets: {
    list: async () => [...fixtures.keys()].map((projectId) => ({ id: `asset-for-${projectId}`, name: assetName(projectId) })),
  },
  catalog: { offerings: async () => [{ disabled: false }] },
  deploymentRuns: { list: async () => [], trigger: async () => undefined },
  workflows: {
    deployments: async () => {
      const all = [...fixtures.values()].flatMap((fixture) => {
        fixture.deploymentsCalls += 1;
        return fixture.deployments;
      });
      return all;
    },
  },
  HubApiError: class HubApiError extends Error {
    constructor(
      readonly status: number,
      ..._rest: unknown[]
    ) {
      super(`hub ${status}`);
    }
  },
  createChildTenant: async () => {
    throw new Error("not exercised");
  },
  getTenant: async (projectId: string) => {
    const fixture = fixtures.get(projectId);
    if (!fixture || fixture.tenantThrows) throw new Error("hub unreachable");
    return fixture.tenant;
  },
  listChildTenants: async () => [],
  patchTenant: async () => {
    throw new Error("not exercised");
  },
  tenantId: (id: string) => id,
  // `mock.module` registrations leak into test files that run later in the
  // same process, where `command-approvals.test.ts` already stubs this same
  // boundary. These inert names mirror its stub surface so a later suite sees
  // a superset of what it sees today, never a smaller one.
  listPrincipals: async () => [],
  evaluate: async () => "deny" as const,
  definitionIdFor: async () => null,
  LEGACY_TENANT_ID: "t_legacy",
}));

mock.module("./hub-mount.js", () => ({
  canPlaceSidecars: () => true,
  hub: () => ({ sidecarBindingFingerprint: "fp-test" }),
}));

// Static imports evaluate before `mock.module` registers, which would load
// the real hub behind `lifecycle-run.js`; the suite reaches it dynamically,
// after the mocks above are in place.
const { currentAnchor } = await import("./lifecycle-run.js");

function setPolicyVersion(fixture: Fixture, version: number): void {
  const tenant = fixture.tenant as { config: { solutionsBuilder: { policyVersion: number } } };
  tenant.config.solutionsBuilder.policyVersion = version;
}

describe("lifecycle anchor invalidation", () => {
  test("a policy-version bump re-resolves the anchor", async () => {
    const projectId = "tnt_anchor_bump";
    const fixture = seed(projectId);
    expect(await currentAnchor(projectId)).toBe(`dep-${projectId}-1`);
    // The installer's stakeholder write: same tenant, new policy version, new deployment.
    setPolicyVersion(fixture, 2);
    fixture.deployments = [
      { id: `dep-${projectId}-2`, definitionAssetId: `asset-for-${projectId}`, status: "active", provisionerBindingFingerprint: null },
    ];
    expect(await currentAnchor(projectId)).toBe(`dep-${projectId}-2`);
  });

  test("an unchanged policy version reuses the anchor without re-resolving", async () => {
    const projectId = "tnt_anchor_stable";
    const fixture = seed(projectId);
    expect(await currentAnchor(projectId)).toBe(`dep-${projectId}-1`);
    const calls = fixture.deploymentsCalls;
    expect(await currentAnchor(projectId)).toBe(`dep-${projectId}-1`);
    expect(fixture.deploymentsCalls).toBe(calls);
  });

  test("an unreadable tenant keeps the remembered anchor", async () => {
    const projectId = "tnt_anchor_dark";
    const fixture = seed(projectId);
    expect(await currentAnchor(projectId)).toBe(`dep-${projectId}-1`);
    fixture.tenantThrows = true;
    expect(await currentAnchor(projectId)).toBe(`dep-${projectId}-1`);
  });
});
