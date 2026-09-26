import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { tenantChain, visibleCatalog } from "./visible-catalog.js";

type Rows = {
  offerings?: object[];
  providers?: object[];
  models?: object[];
};

const WORKSPACE = { id: "tnt_ws", name: "Workspace", slug: "ws", parentId: null, createdAt: "2026-01-01T00:00:00.000Z" };
const PROJECT = { id: "tnt_prj", name: "Project", slug: "prj", parentId: "tnt_ws", createdAt: "2026-01-02T00:00:00.000Z" };

/** A hub whose catalog routes list each tenant's OWN rows only, as the real
 *  ones do -- inheritance is what `visibleCatalog` adds on top. */
function fakeHub(rowsByTenant: Record<string, Rows>): Transport & { reads: string[] } {
  const tenants = [WORKSPACE, PROJECT];
  const reads: string[] = [];
  return {
    reads,
    async fetch<T>(method: string, path: string): Promise<T> {
      reads.push(`${method} ${path}`);
      const [pathname] = path.split("?");
      const tenant = /^\/api\/tenants\/([^/]+)$/.exec(pathname!);
      if (method === "GET" && tenant) {
        const row = tenants.find((entry) => entry.id === tenant[1]);
        if (row) return row as T;
      }
      const catalog = /^\/api\/tenants\/([^/]+)\/catalog\/(offerings|providers|models)$/.exec(pathname!);
      if (method === "GET" && catalog) {
        const rows = rowsByTenant[catalog[1]!] ?? {};
        const data = catalog[2] === "offerings" ? rows.offerings : catalog[2] === "providers" ? rows.providers : rows.models;
        return { data: data ?? [], nextCursor: null } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport & { reads: string[] };
}

const wsRows: Rows = {
  offerings: [{ id: "off_ws", modelId: "mdl_ws", providerId: "mpv_ws", priority: 0, disabled: false }],
  providers: [{ id: "mpv_ws", name: "openai", plugin: "openai", disabled: false }],
  models: [{ id: "mdl_ws", canonicalName: "gpt-5.5" }],
};

describe("tenantChain", () => {
  test("a workspace is its own chain", async () => {
    expect(await tenantChain(fakeHub({}), WORKSPACE.id)).toEqual([WORKSPACE.id]);
  });

  test("a project walks up to the workspace", async () => {
    expect(await tenantChain(fakeHub({}), PROJECT.id)).toEqual([PROJECT.id, WORKSPACE.id]);
  });

  test("an already-read tenant row is not fetched again", async () => {
    const hub = fakeHub({});
    expect(await tenantChain(hub, PROJECT)).toEqual([PROJECT.id, WORKSPACE.id]);
    expect(hub.reads).toEqual([`GET /api/tenants/${WORKSPACE.id}`]);
  });
});

describe("visibleCatalog", () => {
  test("a workspace sees exactly its own rows", async () => {
    const catalog = await visibleCatalog(fakeHub({ [WORKSPACE.id]: wsRows }), WORKSPACE.id);
    expect(catalog.offerings.map((row) => row.id)).toEqual(["off_ws"]);
    expect(catalog.modelProviders.map((row) => row.id)).toEqual(["mpv_ws"]);
    expect(catalog.models.map((row) => row.id)).toEqual(["mdl_ws"]);
  });

  // #30: a project tenant owns no catalog rows; it inherits the workspace's.
  test("a project with an empty catalog of its own sees the workspace's", async () => {
    const catalog = await visibleCatalog(fakeHub({ [WORKSPACE.id]: wsRows }), PROJECT.id);
    expect(catalog.offerings.map((row) => row.id)).toEqual(["off_ws"]);
    expect(catalog.modelProviders.map((row) => row.id)).toEqual(["mpv_ws"]);
    expect(catalog.models.map((row) => row.id)).toEqual(["mdl_ws"]);
  });

  test("a project's own row shadows the workspace's with the same model and provider", async () => {
    const prjRows: Rows = {
      offerings: [{ id: "off_prj", modelId: "mdl_prj", providerId: "mpv_prj", priority: 5, disabled: false }],
      providers: [{ id: "mpv_prj", name: "openai", plugin: "openai", disabled: false }],
      models: [{ id: "mdl_prj", canonicalName: "gpt-5.5" }],
    };
    const catalog = await visibleCatalog(fakeHub({ [WORKSPACE.id]: wsRows, [PROJECT.id]: prjRows }), PROJECT.id);
    expect(catalog.offerings.map((row) => row.id)).toEqual(["off_prj"]);
    expect(catalog.modelProviders.map((row) => row.id)).toEqual(["mpv_prj"]);
    expect(catalog.models.map((row) => row.id)).toEqual(["mdl_prj"]);
  });

  test("a project's own rows merge with the workspace's when they differ", async () => {
    const prjRows: Rows = {
      offerings: [{ id: "off_prj", modelId: "mdl_prj", providerId: "mpv_ws", priority: 5, disabled: false }],
      models: [{ id: "mdl_prj", canonicalName: "claude-fable-5-1" }],
    };
    const catalog = await visibleCatalog(fakeHub({ [WORKSPACE.id]: wsRows, [PROJECT.id]: prjRows }), PROJECT.id);
    expect(catalog.offerings.map((row) => row.id).sort()).toEqual(["off_prj", "off_ws"]);
  });

  test("a disabled offering, or one whose provider is disabled, is not visible", async () => {
    const rows: Rows = {
      offerings: [
        { id: "off_a", modelId: "mdl_ws", providerId: "mpv_ws", priority: 0, disabled: true },
        { id: "off_b", modelId: "mdl_ws", providerId: "mpv_off", priority: 1, disabled: false },
      ],
      providers: [
        { id: "mpv_ws", name: "openai", plugin: "openai", disabled: false },
        { id: "mpv_off", name: "anthropic", plugin: "anthropic", disabled: true },
      ],
      models: [{ id: "mdl_ws", canonicalName: "gpt-5.5" }],
    };
    const catalog = await visibleCatalog(fakeHub({ [WORKSPACE.id]: rows }), PROJECT.id);
    expect(catalog.offerings).toEqual([]);
  });
});
