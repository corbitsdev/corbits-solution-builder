import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { findProjectWorkflow, projectWorkflowAssetName } from "./project-workflow-deploy.js";

const TENANT_ID = "tnt_1";
const PROJECT_ID = "proj_1";
const ASSET_ID = "asset_1";

type Fixture = {
  assets?: { id: string; name: string }[];
  deployments?: { id: string; definitionAssetId: string; status: string; createdAt: string }[];
  runsByDeployment?: Record<string, string[]>;
};

function fakeTransport(fixture: Fixture): Transport {
  return {
    async fetch<T>(method: string, path: string): Promise<T> {
      const [pathname] = path.split("?");
      if (method === "GET" && pathname === `/api/tenants/${TENANT_ID}/assets`) {
        return (fixture.assets ?? []).map((asset) => ({ ...asset, tenantId: TENANT_ID, kind: "workflow" })) as T;
      }
      if (method === "GET" && pathname === `/api/tenants/${TENANT_ID}/workflows/deployments`) {
        return (fixture.deployments ?? []).map((entry) => ({ ...entry, tenantId: TENANT_ID })) as T;
      }
      const runsMatch = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/runs$/.exec(pathname ?? "");
      if (method === "GET" && runsMatch) {
        return { runIds: fixture.runsByDeployment?.[runsMatch[1]!] ?? [] } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("findProjectWorkflow", () => {
  test("no asset yet -> null", async () => {
    const transport = fakeTransport({});
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("asset exists but no deployment matches it -> null", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_other", definitionAssetId: "asset_other", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("deployment exists but no top-level run has been triggered -> null", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: { dep_1: [] },
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("several top-level runs already exist -> picks the oldest, the same winner every caller converges on", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: {
        // Iteration children (contain `__`) are excluded; only bare ids count.
        dep_1: ["run_b", "run_a__rework__1", "run_c", "run_a"],
      },
    });
    const result = await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID);
    expect(result).toEqual({ deploymentId: "dep_1", runId: "run_a" });
  });

  test("prefers the live deployment over an ended one on the same asset", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [
        { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "dep_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
      runsByDeployment: { dep_live: ["run_1"], dep_old_failed: ["run_0"] },
    });
    const result = await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID);
    expect(result).toEqual({ deploymentId: "dep_live", runId: "run_1" });
  });
});
