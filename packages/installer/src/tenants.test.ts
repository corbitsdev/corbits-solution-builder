import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { getTenant, listChildTenants } from "./tenants.js";

/**
 * Fixtures shaped exactly like `formatTenant` in
 * `vendor/interchange/packages/hub-api/src/routes/tenants.ts`, so a route
 * response drift breaks these before it breaks a caller.
 */
function tenantRow(id: string, parentId: string | null) {
  return {
    id,
    name: `Project ${id}`,
    slug: id,
    domain: `${id}.localhost`,
    parentId,
    config: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeTransport(rows: ReturnType<typeof tenantRow>[]): Transport {
  return {
    async fetch<T>(method: string, path: string): Promise<T> {
      const [pathname, query] = path.split("?");
      if (method === "GET" && pathname === "/api/tenants") {
        const parentId = new URLSearchParams(query).get("parentId");
        return rows.filter((row) => row.parentId === parentId) as T;
      }
      const match = /^\/api\/tenants\/([^/]+)$/.exec(pathname ?? "");
      if (method === "GET" && match) {
        const row = rows.find((entry) => entry.id === match[1]);
        if (!row) throw new ApiError(404, "not_found", "not found");
        return row as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("listChildTenants", () => {
  test("returns only tenants parented on the workspace", async () => {
    const rows = [tenantRow("ws", null), tenantRow("p1", "ws"), tenantRow("p2", "ws"), tenantRow("other", "elsewhere")];
    const transport = fakeTransport(rows);
    const children = await listChildTenants(transport, "ws");
    expect(children.map((row) => row.id)).toEqual(["p1", "p2"]);
  });
});

describe("getTenant", () => {
  test("returns the tenant by id", async () => {
    const transport = fakeTransport([tenantRow("p1", "ws")]);
    const tenant = await getTenant(transport, "p1");
    expect(tenant?.name).toBe("Project p1");
  });
});
