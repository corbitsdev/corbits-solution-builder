import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { stageSpecialistAddresses } from "./specialist-deploy.js";

const TENANT = {
  id: "tnt_ws",
  name: "Workspace",
  slug: "workspace",
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  domain: "ws.example",
};

function assetRow(id: string, name: string) {
  return { id, tenantId: TENANT.id, kind: "workflow", name };
}

function deploymentRow(id: string, definitionAssetId: string, status: string) {
  return { id, tenantId: TENANT.id, definitionAssetId, status, createdAt: "2026-01-01T00:00:00.000Z" };
}

function fakeTransport(args: {
  assets: ReturnType<typeof assetRow>[];
  deployments: ReturnType<typeof deploymentRow>[];
}): Transport {
  return {
    async fetch<T>(method: string, path: string): Promise<T> {
      if (method === "GET" && path === `/api/tenants/${TENANT.id}`) return TENANT as T;
      if (method === "GET" && path.startsWith(`/api/tenants/${TENANT.id}/assets?kind=`)) return args.assets as T;
      if (method === "GET" && path === `/api/tenants/${TENANT.id}/workflows/deployments`) return args.deployments as T;
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("stageSpecialistAddresses", () => {
  test("collects every deployment's address for the stage's asset, live and ended alike", async () => {
    const transport = fakeTransport({
      assets: [assetRow("asset_1", "sb-project-p1-stage-1"), assetRow("asset_2", "sb-project-p1-stage-2")],
      deployments: [
        deploymentRow("dep_old", "asset_1", "released"),
        deploymentRow("dep_live", "asset_1", "deployed"),
        deploymentRow("dep_other_stage", "asset_2", "deployed"),
      ],
    });
    const addresses = await stageSpecialistAddresses(transport, TENANT.id, "p1", 1 as never);
    expect(addresses.sort()).toEqual(["dep_live@ws.example", "dep_old@ws.example"].sort());
  });

  test("empty when the stage's asset has never been deployed", async () => {
    const transport = fakeTransport({ assets: [], deployments: [] });
    const addresses = await stageSpecialistAddresses(transport, TENANT.id, "p1", 1 as never);
    expect(addresses).toEqual([]);
  });

  test("empty when the tenant has no mail domain yet", async () => {
    const transport = {
      async fetch<T>(method: string, path: string): Promise<T> {
        if (method === "GET" && path === `/api/tenants/${TENANT.id}`) return { ...TENANT, domain: undefined } as T;
        throw new Error(`unexpected ${method} ${path}`);
      },
    } as Transport;
    const addresses = await stageSpecialistAddresses(transport, TENANT.id, "p1", 1 as never);
    expect(addresses).toEqual([]);
  });
});
