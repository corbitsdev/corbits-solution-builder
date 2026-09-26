import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { leadingOffering, specialistEntryIsCurrent, stageSpecialistAddresses, stageSpecialistStatus } from "./specialist-deploy.js";
import { visibleCatalog } from "./visible-catalog.js";
import { deployOrExplain, ModelProviderNotDelegatedError, sourceFor } from "./workflow-deploy.js";
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

/** The project: a child tenant of the workspace, with its own mail domain. */
const PROJECT_TENANT = {
  id: "p1",
  name: "Project",
  slug: "p1",
  parentId: TENANT.id,
  createdAt: "2026-01-02T00:00:00.000Z",
  domain: "p1.example",
};

function assetRow(id: string, name: string, tenantId: string = PROJECT_TENANT.id) {
  return { id, tenantId, kind: "workflow", name };
}

function deploymentRow(id: string, definitionAssetId: string, status: string, tenantId: string = PROJECT_TENANT.id) {
  return { id, tenantId, definitionAssetId, status, createdAt: "2026-01-01T00:00:00.000Z" };
}

/** A hub whose asset listing is inherited (the project lists the workspace's
 *  rows too, tagged with their tenant) and whose deployments are per tenant. */
function fakeTransport(args: {
  assets: ReturnType<typeof assetRow>[];
  deployments: ReturnType<typeof deploymentRow>[];
  project?: typeof PROJECT_TENANT;
}): Transport {
  const project = args.project ?? PROJECT_TENANT;
  return {
    async fetch<T>(method: string, path: string): Promise<T> {
      if (method === "GET" && path === `/api/tenants/${TENANT.id}`) return TENANT as T;
      if (method === "GET" && path === `/api/tenants/${project.id}`) return project as T;
      if (method === "GET" && path.startsWith(`/api/tenants/${project.id}/assets?kind=`)) return args.assets as T;
      const deployments = /^\/api\/tenants\/([^/]+)\/workflows\/deployments$/.exec(path);
      if (method === "GET" && deployments) return args.deployments.filter((row) => row.tenantId === deployments[1]) as T;
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
    const addresses = await stageSpecialistAddresses(transport, "p1", 1);
    expect(addresses.sort()).toEqual(["dep_live@p1.example", "dep_old@p1.example"].sort());
  });

  // #29: a project deployed before specialists moved into its own tenant
  // still has a specialist in the workspace. Its addresses are part of the
  // stage's thread, at the workspace's domain, after the project's own.
  test("includes a legacy deployment on the workspace's same-named asset, at the workspace's domain", async () => {
    const transport = fakeTransport({
      assets: [assetRow("asset_own", "sb-project-p1-stage-1"), assetRow("asset_ws", "sb-project-p1-stage-1", TENANT.id)],
      deployments: [deploymentRow("dep_own", "asset_own", "deployed"), deploymentRow("dep_legacy", "asset_ws", "released", TENANT.id)],
    });
    expect(await stageSpecialistAddresses(transport, "p1", 1)).toEqual(["dep_own@p1.example", "dep_legacy@ws.example"]);
  });

  test("empty when the stage's asset has never been deployed", async () => {
    const transport = fakeTransport({ assets: [], deployments: [] });
    const addresses = await stageSpecialistAddresses(transport, "p1", 1);
    expect(addresses).toEqual([]);
  });

  test("empty when the tenant has no mail domain yet", async () => {
    const transport = fakeTransport({
      assets: [assetRow("asset_1", "sb-project-p1-stage-1")],
      deployments: [deploymentRow("dep_live", "asset_1", "deployed")],
      project: { ...PROJECT_TENANT, domain: undefined as unknown as string },
    });
    const addresses = await stageSpecialistAddresses(transport, "p1", 1);
    expect(addresses).toEqual([]);
  });
});

// #29: the live pick comes from the project's own tenant first; a legacy
// workspace deployment is reported only while nothing of the project's own
// is live, and never displaces a live one.
describe("stageSpecialistStatus across the project tenant and the workspace", () => {
  const assets = [assetRow("asset_own", "sb-project-p1-stage-1"), assetRow("asset_ws", "sb-project-p1-stage-1", TENANT.id)];
  const withConfig = (transport: Transport): Transport =>
    ({
      async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
        // No switch record on the project tenant.
        if (method === "GET" && path === `/api/tenants/${PROJECT_TENANT.id}`) return { ...PROJECT_TENANT, config: {} } as T;
        return transport.fetch<T>(method, path, body);
      },
    }) as Transport;

  test("a live legacy deployment is the pick while the project tenant has none", async () => {
    const transport = withConfig(fakeTransport({ assets, deployments: [deploymentRow("dep_legacy", "asset_ws", "deployed", TENANT.id)] }));
    expect(await stageSpecialistStatus(transport, "p1", 1)).toEqual({
      deploymentId: "dep_legacy",
      address: "dep_legacy@ws.example",
      status: "deployed",
      tenantId: TENANT.id,
    });
  });

  test("a live deployment in the project tenant wins over an ended legacy one", async () => {
    const transport = withConfig(
      fakeTransport({
        assets,
        deployments: [deploymentRow("dep_legacy", "asset_ws", "released", TENANT.id), deploymentRow("dep_own", "asset_own", "deployed")],
      }),
    );
    expect(await stageSpecialistStatus(transport, "p1", 1)).toMatchObject({ deploymentId: "dep_own", tenantId: PROJECT_TENANT.id });
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
  const providers = [{ id: "mpv_1", name: "openai", plugin: "openai", disabled: false }];
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
        if (method === "GET" && path === `/api/tenants/${TENANT.id}`) return TENANT as T;
        if (method === "GET" && path.startsWith(`/api/tenants/${TENANT.id}/catalog/offerings`)) return { data: [offering], nextCursor: null } as T;
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

// #30: a project (child) tenant owns no catalog rows. The installer's reads
// must see the workspace's rows the project inherits, so a deploy into the
// project tenant can name them -- and the hub, not the installer, then
// decides whether the project was given the credential behind them.
describe("deploying into a project tenant", () => {
  const PROJECT = { id: "tnt_prj", name: "Project", slug: "prj", parentId: TENANT.id, createdAt: "2026-01-02T00:00:00.000Z", domain: "prj.example" };
  const offering = { id: "off_1", providerId: "mpv_1", modelId: "mdl_1", priority: 0, disabled: false };
  const providers = [{ id: "mpv_1", name: "openai", plugin: "openai", disabled: false }];
  const models = [{ id: "mdl_1", canonicalName: "gpt-5.5" }];

  /** Catalog routes list a tenant's OWN rows: the workspace has them, the project has none. */
  function transportWithParentCatalog(): Transport {
    return {
      async fetch<T>(method: string, path: string): Promise<T> {
        const [pathname] = path.split("?");
        if (method === "GET" && pathname === `/api/tenants/${TENANT.id}`) return TENANT as T;
        if (method === "GET" && pathname === `/api/tenants/${PROJECT.id}`) return PROJECT as T;
        const catalog = /^\/api\/tenants\/([^/]+)\/catalog\/(offerings|providers|models)$/.exec(pathname!);
        if (method === "GET" && catalog) {
          if (catalog[1] !== TENANT.id) return { data: [], nextCursor: null } as T;
          const data = catalog[2] === "offerings" ? [offering] : catalog[2] === "providers" ? providers : models;
          return { data, nextCursor: null } as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    } as Transport;
  }

  test("the source pin resolves through the workspace's catalog", async () => {
    expect(await sourceFor(transportWithParentCatalog(), PROJECT.id, offering)).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  test("the visible offerings are the workspace's, from a project whose own catalog is empty", async () => {
    const catalog = await visibleCatalog(transportWithParentCatalog(), PROJECT.id);
    expect(catalog.offerings.map((row) => row.id)).toEqual(["off_1"]);
  });

  test("the hub's offering refusal in a project reads as an undelegated provider, not a missing one", async () => {
    const refusal = new ApiError(409, "source_offering_unavailable", "Catalog offering off_1 cannot be used by the deployment authority");
    const thrown = await deployOrExplain(PROJECT, () => Promise.reject(refusal)).catch((cause: unknown) => cause);
    expect(thrown).toBeInstanceOf(ModelProviderNotDelegatedError);
    expect((thrown as Error).message).toContain("has not been given a model provider");
    expect((thrown as Error).message).not.toContain("connect a model provider");
    // Not an `ApiError`: `ensureSpecialistDeployment`'s retry-once-on-409
    // absorbs races, and must not repeat a refusal that will not change.
    expect(thrown).not.toBeInstanceOf(ApiError);
  });

  test("the same refusal in the workspace itself does not blame a delegation", async () => {
    const refusal = new ApiError(409, "source_offering_unavailable", "Catalog offering off_1 cannot be used by the deployment authority");
    const thrown = await deployOrExplain(TENANT, () => Promise.reject(refusal)).catch((cause: unknown) => cause);
    expect(thrown).toBeInstanceOf(ModelProviderNotDelegatedError);
    expect((thrown as Error).message).not.toContain("project");
  });

  test("every other deploy failure passes through untouched", async () => {
    const conflict = new ApiError(409, "conflict", "deployment exists");
    const thrown = await deployOrExplain(PROJECT, () => Promise.reject(conflict)).catch((cause: unknown) => cause);
    expect(thrown).toBe(conflict);
    expect(await deployOrExplain(PROJECT, () => Promise.resolve("ok"))).toBe("ok");
  });
});
