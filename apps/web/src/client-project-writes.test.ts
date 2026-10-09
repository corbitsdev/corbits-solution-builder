import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./client.ts";
import { cacheProjectWorkflowRef } from "./project-workflow-ref.ts";

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
      // A project workflow run, parked on its decision await in whichever tenant it lives.
      const events = /\/workflows\/[^/]+\/runs\/([^/]+)\/events$/.exec(path);
      if (events && method === "GET") return json({ runId: events[1], events: [{ seq: 1, type: "SignalAwaited", body: {} }] });
      // A project workflow signal, in whichever tenant it is sent to.
      if (/\/workflows\/[^/]+\/signals$/.test(path) && method === "POST") return json({ ok: true }, 202);
      // Artifacts: any tenant's listing is empty, and a create answers with a row in that tenant.
      if (/\/api\/tenants\/[^/]+\/artifacts(\?|$)/.test(path) && method === "GET") return json({ data: [], nextCursor: null });
      if (/\/api\/tenants\/[^/]+\/artifacts$/.test(path) && method === "POST") {
        return json({ artifact: { id: `art_${String(calls.length)}`, version: 1, title: "", metadata: JSON.parse(String(init?.body ?? "{}")).metadata ?? null } }, 201);
      }
      return json({ error: { code: "not_found", message: path } }, 404);
    }) as typeof fetch;
    return { calls, current: () => current };
  }

  // #163: the workflow deployment lives in the tenant its ref names, the
  // project's own since #29. Signalling the workspace 404s silently and
  // no review ever opens.
  test("decide signals the deployment in the tenant its ref names, not the workspace", async () => {
    const { calls } = mockHub();
    cacheProjectWorkflowRef("proj-1", { deploymentId: "dep_1", runId: "run_1", tenantId: "proj-1" });
    await api.decide("proj-1", { decisionId: "dec-1", kind: "open_review", stage: 1 });
    const signals = calls.filter((call) => call.method === "POST" && /\/signals$/.test(call.url)).map((call) => call.url);
    expect(signals).toEqual(["/api/tenants/proj-1/workflows/dep_1/signals"]);
  });

  test("decide still signals a legacy deployment in the workspace when its ref says so", async () => {
    const { calls } = mockHub();
    cacheProjectWorkflowRef("proj-1", { deploymentId: "dep_legacy", runId: "run_0", tenantId: "tnt_ws" });
    await api.decide("proj-1", { decisionId: "dec-2", kind: "approve", stage: 1 });
    expect(calls.filter((call) => call.method === "POST" && /\/signals$/.test(call.url)).map((call) => call.url)).toEqual(["/api/tenants/tnt_ws/workflows/dep_legacy/signals"]);
  });

  // #137: a project's artifacts live in its own tenant since #29. These two
  // writes still went to the workspace, where any project's bearer could
  // reach them by label.
  test("persistBuildEvidence writes the archive and its manifest into the project tenant", async () => {
    const { calls } = mockHub();
    await api.persistBuildEvidence("proj-1", {
      fileName: "alpha-attempt-2.tar.gz",
      mediaType: "application/gzip",
      dataUri: "data:application/gzip;base64,AAAA",
      sizeBytes: 3,
      manifest: { attempt: "attempt-2", files: [] },
    });
    const writes = calls.filter((call) => call.method === "POST" && /\/artifacts$/.test(call.url)).map((call) => call.url);
    expect(writes).toEqual(["/api/tenants/proj-1/artifacts", "/api/tenants/proj-1/artifacts"]);
    expect(calls.some((call) => call.url.startsWith("/api/tenants/tnt_ws/artifacts") && call.method === "POST")).toBe(false);
  });

  test("persistAudiencePackage writes a stakeholder's package into the project tenant", async () => {
    const { calls } = mockHub();
    await api.persistAudiencePackage("proj-1", "You", "# Package\n\nHello.");
    const writes = calls.filter((call) => call.method === "POST" && /\/artifacts$/.test(call.url)).map((call) => call.url);
    expect(writes).toEqual(["/api/tenants/proj-1/artifacts"]);
  });

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

  // #722: a stakeholder's interview is kept on their entry, within bounds,
  // and an entry sent without it keeps the one on record.
  const said = [{ question: " What do you most need to see to say yes? ", answer: "The cost ceiling. " }];

  test("an entry with an interview survives the save, trimmed", async () => {
    const { current } = mockHub();
    const result = await api.setStakeholders("proj-1", { audiences: [{ name: "You", role: "project_owner" }, { name: "Dana", role: "budget_approver", interview: said }], audienceQuorum: 2 });
    expect(result.audiences[1]).toEqual({ name: "Dana", role: "budget_approver", interview: [{ question: "What do you most need to see to say yes?", answer: "The cost ceiling." }] });
    expect(result.audiences[0]).toEqual({ name: "You", role: "project_owner" });
    expect(current().config.solutionsBuilder.policy.audiences[1]).toHaveProperty("interview");
  });

  test("an entry sent without its interview keeps the one on record; an empty list clears it", async () => {
    mockHub();
    await api.setStakeholders("proj-1", { audiences: [{ name: "Dana", role: "budget_approver", interview: said }], audienceQuorum: 1 });
    const kept = await api.setStakeholders("proj-1", { audiences: [{ name: "dana", role: "technical_approver" }], audienceQuorum: 1 });
    expect(kept.audiences[0]).toEqual({ name: "dana", role: "technical_approver", interview: [{ question: "What do you most need to see to say yes?", answer: "The cost ceiling." }] });
    const cleared = await api.setStakeholders("proj-1", { audiences: [{ name: "Dana", role: "budget_approver", interview: [] }], audienceQuorum: 1 });
    expect(cleared.audiences[0]).toEqual({ name: "Dana", role: "budget_approver" });
  });

  test("more than five entries, a side missing, a side over 500 characters, or not a list is refused", async () => {
    mockHub();
    const attempt = (interview: unknown) => api.setStakeholders("proj-1", { audiences: [{ name: "Dana", role: "budget_approver", interview }], audienceQuorum: 1 });
    await expect(attempt(Array.from({ length: 6 }, () => ({ question: "q", answer: "a" })))).rejects.toThrow("5 at most");
    await expect(attempt([{ question: "q", answer: " " }])).rejects.toThrow("without a question or an answer");
    await expect(attempt([{ question: "q", answer: "a".repeat(501) }])).rejects.toThrow("over 500 characters");
    await expect(attempt("none")).rejects.toThrow("not a list");
  });
});
