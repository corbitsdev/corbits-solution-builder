import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { leadingOffering, specialistEntryIsCurrent, stageSpecialistAddresses } from "./specialist-deploy.js";
import { ApiError } from "@intx/hub-client";
import { agentFor } from "@solutions-builder/app/kit";
import { SPECIALIST_ENTRY_PATH, specialistEntrySource } from "@solutions-builder/app/specialist-source";

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

// #103: a live specialist whose entry the kit has since changed is redeployed
// onto the model it already leads with -- never silently onto another.
describe("leadingOffering", () => {
  const offerings = [{ id: "off_default" }, { id: "off_switched" }];

  test("the catalog's first when nothing was switched", () => {
    expect(leadingOffering(null, "dep_1", offerings)).toEqual({ id: "off_default" });
  });

  test("the switched offering while the record still points at this deployment", () => {
    const recorded = { deploymentId: "dep_1", offeringId: "off_switched" };
    expect(leadingOffering(recorded, "dep_1", offerings)).toEqual({ id: "off_switched" });
  });

  test("the catalog's first when the record points at another deployment, or names an offering no longer connected", () => {
    expect(leadingOffering({ deploymentId: "dep_old", offeringId: "off_switched" }, "dep_1", offerings)).toEqual({ id: "off_default" });
    expect(leadingOffering({ deploymentId: "dep_1", offeringId: "off_gone" }, "dep_1", offerings)).toEqual({ id: "off_default" });
  });
});

// #103: the entry a live specialist runs is compared against a fresh render
// for the same stage, role and model -- the brief included.
describe("specialistEntryIsCurrent", () => {
  const offering = { id: "off_1", providerId: "mpv_1", modelId: "mdl_1" };
  const providers = [{ id: "mpv_1", plugin: "openai" }];
  const models = [{ id: "mdl_1", canonicalName: "gpt-5.5" }];
  const role = agentFor(4);
  const rendered = specialistEntrySource({
    stage: 4,
    source: { provider: "openai", model: "gpt-5.5" },
    projectId: "prj_1",
    assetName: "sb-project-prj_1-stage-4",
    role,
    roleKey: "primary",
    artifactTools: false,
  });

  function transportWithEntry(deployed: string | null): Transport {
    const blob = `/api/tenants/${TENANT.id}/assets/ast_1/blob?path=${encodeURIComponent(`packages/specialist/${SPECIALIST_ENTRY_PATH}`)}`;
    return {
      async fetch<T>(method: string, path: string): Promise<T> {
        if (method === "GET" && path === blob) {
          if (deployed === null) throw new ApiError(404, "not_found", "no such blob");
          return { content: btoa(String.fromCharCode(...new TextEncoder().encode(deployed))) } as T;
        }
        if (method === "GET" && path.startsWith(`/api/tenants/${TENANT.id}/catalog/providers`)) return { data: providers, nextCursor: null } as T;
        if (method === "GET" && path.startsWith(`/api/tenants/${TENANT.id}/catalog/models`)) return { data: models, nextCursor: null } as T;
        throw new Error(`unexpected ${method} ${path}`);
      },
    } as Transport;
  }

  const check = (deployed: string | null) =>
    specialistEntryIsCurrent(transportWithEntry(deployed), TENANT.id, "ast_1", "sb-project-prj_1-stage-4", "prj_1", 4, offering, false, "primary", role);

  test("current when the deployed entry is what the kit renders today", async () => {
    expect(await check(rendered)).toBe(true);
  });

  test("stale when the kit's brief has moved on since the deploy", async () => {
    expect(rendered).toContain("A phone screen is drawn as the screen, never as the phone.");
    const before = rendered.replace("A phone screen is drawn as the screen, never as the phone.", "");
    expect(await check(before)).toBe(false);
  });

  test("an entry that cannot be read back is not a reason to redeploy", async () => {
    expect(await check(null)).toBe(true);
  });
});
