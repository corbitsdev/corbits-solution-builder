import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A hub with one workspace and no artifacts yet; records what `persistStageDraft` writes. */
function mockHub() {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (href.endsWith("/api/me")) return json({ id: "user-1" });
    if (href.includes("/api/me/principals")) {
      return json({ data: [{ principalId: "prn_1", tenantId: "tnt_ws", tenantSlug: "solutions-builder", kind: "user", status: "active", roles: [] }] });
    }
    if (method === "POST" && /\/artifacts$/.test(href)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posted.push({ url: href, body });
      return json({ artifact: { id: "art_new", version: 1, kind: "document", title: body.title, metadata: body.metadata, createdAt: "2026-09-24T12:00:00.000Z" } }, 201);
    }
    if (href.includes("/artifacts")) return json({ artifacts: [], nextCursor: null });
    return json({ error: { code: "not_found", message: href } }, 404);
  }) as typeof fetch;
  return posted;
}

describe("persistStageDraft", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("stamps the stage's own specialist as the draft's provenance, so the write is found as the draft on the next look", async () => {
    const posted = mockHub();
    await api.persistStageDraft("proj-1", 6, "# Build plan\n\n## Stack\n", []);
    expect(posted).toHaveLength(1);
    const sb = (posted[0]!.body.metadata as { sb: Record<string, unknown> }).sb;
    expect(sb.kind).toBe("build_plan");
    expect(sb.stage).toBe(6);
    expect(sb.provenance).toEqual({ producer: "agent", agentRole: "architect" });
  });

  test("stage 1's draft carries the brainstormer; the stamp follows the stage, not a fixed role", async () => {
    const posted = mockHub();
    await api.persistStageDraft("proj-1", 1, "# Problem brief\n\nEnough text.", []);
    const sb = (posted[0]!.body.metadata as { sb: Record<string, unknown> }).sb;
    expect((sb.provenance as { agentRole?: string }).agentRole).toBe("brainstormer");
  });
});
