import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./client.ts";

const POLICY = {
  costTolerancePercent: 10,
  costToleranceAbsolute: 100,
  audiences: [{ name: "You", role: "project_owner" as const }],
  audienceQuorum: 1,
  allowExternalProviders: true,
};

function tenant(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    config: {
      solutionsBuilder: {
        policy: POLICY,
        policyVersion: 1,
        revision: 1,
        archivedAt: null,
        deletedAt: null,
        ...extra,
      },
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("client project tenant writes", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  function mockHub() {
    const calls: { url: string; method: string }[] = [];
    let current = tenant("Alpha");
    const roles = new Map<string, { id: string; name: string }>();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: href, method });
      const path = href;

      if (path === "/api/me") return json({ id: "user-1" });
      if (path.startsWith("/api/me/principals")) {
        return json({
          data: [
            {
              principalId: "prn_owner",
              tenantId: "tnt_ws",
              tenantSlug: "solutions-builder",
              kind: "user",
              status: "active",
            },
            {
              principalId: "prn_owner",
              tenantId: "proj-1",
              tenantSlug: "alpha",
              kind: "user",
              status: "active",
            },
          ],
          nextCursor: null,
        });
      }
      if (method === "GET" && path === "/api/tenants/proj-1") return json(current);
      if (method === "PATCH" && path === "/api/tenants/proj-1") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          name?: string;
          config?: typeof current.config;
        };
        current = {
          ...current,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.config !== undefined ? { config: body.config } : {}),
        };
        return json(current);
      }
      if (path.startsWith("/api/tenants/proj-1/roles") && method === "GET") {
        return json({ data: [...roles.values()], nextCursor: null });
      }
      if (path === "/api/tenants/proj-1/roles" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
        const role = { id: `role-${roles.size + 1}`, name: body.name, description: null, isSystem: false };
        roles.set(body.name, role);
        return json(role, 201);
      }
      if (path.startsWith("/api/tenants/proj-1/grants") && method === "GET") {
        return json({ data: [], nextCursor: null });
      }
      if (path === "/api/tenants/proj-1/grants" && method === "POST") {
        return json({ id: "g1", roleId: "role-1", principalId: null, resource: "authority:project_owner", action: "hold", effect: "allow", origin: "role" }, 201);
      }
      if (path.includes("/principals/") && method === "POST") return json({ ok: true });
      return json({ error: { code: "not_found", message: path } }, 404);
    }) as typeof fetch;
    return { calls, current: () => current };
  }

  test("updateProject patches the hub tenant, not the host project route", async () => {
    const { calls, current } = mockHub();
    await expect(api.updateProject("proj-1", { title: "Beta" })).resolves.toEqual({ ok: true });
    expect(calls.some((call) => call.url.startsWith("/api/projects"))).toBe(false);
    expect(calls).toContainEqual({ url: "/api/tenants/proj-1", method: "PATCH" });
    expect(current().name).toBe("Beta");
  });

  test("deleteProject marks the hub tenant deleted and never DELETEs the host project", async () => {
    const { calls, current } = mockHub();
    await expect(api.deleteProject("proj-1")).resolves.toEqual({ ok: true });
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/projects/"))).toBe(false);
    expect(calls).toContainEqual({ url: "/api/tenants/proj-1", method: "PATCH" });
    expect(current().config.solutionsBuilder.deletedAt).not.toBeNull();
  });

  test("setStakeholders writes policy on the hub tenant, not PUT /projects/stakeholders", async () => {
    const { calls, current } = mockHub();
    const result = await api.setStakeholders("proj-1", {
      audiences: [
        { name: "You", role: "project_owner" },
        { name: "Dana", role: "budget_approver" },
      ],
      audienceQuorum: 2,
    });
    expect(calls.some((call) => call.method === "PUT" && call.url.includes("/stakeholders"))).toBe(false);
    expect(calls).toContainEqual({ url: "/api/tenants/proj-1", method: "PATCH" });
    expect(current().config.solutionsBuilder.policy.audiences.map((row) => row.name)).toEqual(["You", "Dana"]);
    expect(result.audienceQuorum).toBe(2);
  });
});
