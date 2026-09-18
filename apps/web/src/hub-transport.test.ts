import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@intx/hub-client";
import { createHubTransport } from "./hub.ts";
import { api, rerankCatalogAfterSkillAssets } from "./client.ts";

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

  test("reranks through hub catalog routes, not the host provider domain", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: init?.method });
      return jsonForCatalog(href);
    }) as typeof fetch;

    await rerankCatalogAfterSkillAssets();
    expect(calls.some((call) => call.url.startsWith("/api/"))).toBe(false);
    expect(calls.map((call) => call.url)).toContain("/hub/api/tenants/t_ws/catalog/providers?limit=100");
    expect(calls.map((call) => call.url)).toContain("/hub/api/tenants/t_ws/catalog/offerings?limit=100");
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.url)).toEqual([
      "/hub/api/tenants/t_ws/catalog/offerings/o-emb",
      "/hub/api/tenants/t_ws/catalog/offerings/o-chat",
    ]);
  });
});

describe("api.providers", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("lists connected providers from the hub catalog", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      urls.push(href);
      return jsonForCatalog(href);
    }) as typeof fetch;

    const listed = await api.providers();
    expect(urls.some((href) => href === "/api/providers" || href.startsWith("/api/providers?"))).toBe(false);
    expect(urls).toContain("/hub/api/tenants/t_ws/catalog/providers?limit=100");
    expect(listed.providers).toEqual([
      {
        id: "mp1",
        providerId: "openai",
        label: "OpenAI",
        kind: "api_key",
        baseUrl: "https://api.openai.com/v1",
        status: "ready",
        statusDetail: null,
        models: ["gpt-4o"],
        active: true,
        priority: 0,
        hasCredential: true,
        validatedAt: "2026-01-01T00:00:00.000Z",
        selectedModel: null,
      },
    ]);
    expect(listed.apiKeyProviders.map((entry) => entry.providerId)).toContain("openai");
    expect(listed.oauthCandidates.map((entry) => entry.providerId)).toEqual(["codex-oauth", "xai-oauth"]);
  });

  test("an unauthenticated hub is an empty list, not a host /providers call", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "no" } }), { status: 401 });
    }) as typeof fetch;

    const listed = await api.providers();
    expect(listed.providers).toEqual([]);
    expect(urls.some((href) => href.startsWith("/api/"))).toBe(false);
  });
});

function page<T>(data: T[]) {
  return { data, nextCursor: null };
}

function jsonForCatalog(href: string): Response {
  const body = catalogBody(href);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function catalogBody(href: string): unknown {
  if (href === "/hub/api/me") return { id: "u1" };
  if (href.startsWith("/hub/api/me/principals")) {
    return page([
      {
        principalId: "prn1",
        tenantId: "t_ws",
        tenantSlug: "solutions-builder",
        kind: "user",
        status: "active",
      },
    ]);
  }
  if (href.startsWith("/hub/api/tenants/t_ws/catalog/providers")) {
    return page([
      {
        id: "mp1",
        name: "openai",
        plugin: "openai",
        baseURL: "https://api.openai.com/v1",
        credentialId: "c1",
        disabled: false,
      },
    ]);
  }
  if (href.startsWith("/hub/api/tenants/t_ws/credentials")) {
    return page([
      {
        id: "c1",
        providerId: "p1",
        name: "openai",
        type: "api_key",
        status: "active",
        principalId: null,
        metadata: {},
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  }
  if (href.startsWith("/hub/api/tenants/t_ws/catalog/models")) {
    return page([
      { id: "m-emb", canonicalName: "text-embedding-3-small", displayName: "emb" },
      { id: "m-chat", canonicalName: "gpt-4o", displayName: "GPT-4o" },
    ]);
  }
  if (href.startsWith("/hub/api/tenants/t_ws/catalog/offerings") && !href.includes("/o-")) {
    return page([
      { id: "o-emb", modelId: "m-emb", providerId: "mp1", priority: 0, capabilities: [], quirks: null, disabled: false },
      { id: "o-chat", modelId: "m-chat", providerId: "mp1", priority: 1, capabilities: ["plain-text"], quirks: null, disabled: false },
    ]);
  }
  if (href.startsWith("/hub/api/tenants/t_ws/providers")) {
    return page([
      {
        id: "p1",
        name: "openai",
        plugin: "openai",
        apiBaseUrl: "https://api.openai.com/v1",
        metadata: { label: "OpenAI" },
      },
    ]);
  }
  if (href.startsWith("/hub/api/tenants/t_ws/catalog/offerings/")) return { ok: true };
  return {};
}
