import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@solutions-builder/installer";
import { api, createHubTransport, rerankCatalogAfterSkillAssets } from "./client.ts";

describe("createHubTransport", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("calls /hub with same-origin credentials", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return new Response(JSON.stringify({ id: "u1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const body = await createHubTransport().fetch<{ id: string }>("GET", "/api/me");
    expect(body).toEqual({ id: "u1" });
    expect(calls).toEqual([{ url: "/hub/api/me", init: { method: "GET", credentials: "same-origin" } }]);
  });

  test("posts JSON to /hub and keeps same-origin credentials", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await createHubTransport().fetch("POST", "/api/tenants", { name: "workspace" });
    expect(calls[0]?.url).toBe("/hub/api/tenants");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: "workspace" }));
  });

  test("surfaces a hub error as ApiError with status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthenticated", message: "no" } }), {
        status: 401,
      })) as unknown as typeof fetch;

    try {
      await createHubTransport().fetch("GET", "/api/me");
      throw new Error("expected ApiError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).status).toBe(401);
      expect((cause as ApiError).code).toBe("unauthenticated");
    }
  });
});

describe("rerankCatalogAfterSkillAssets", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("posts the host rerank install used to run as afterSkillAssets", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ reordered: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await rerankCatalogAfterSkillAssets();
    expect(calls.map((call) => call.url)).toEqual(["/api/catalog/rerank"]);
    expect(calls[0]?.method).toBe("POST");
  });

  test("client install still passes that rerank as afterSkillAssets", () => {
    expect(api.install.toString()).toContain("rerankCatalogAfterSkillAssets");
  });
});
