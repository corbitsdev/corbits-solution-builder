import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { listWorkspaceResolvedModels, resolveActiveModel, staleAnthropicBase, type ResolvedModel } from "../provider-catalog.js";
import { needsModelChoice } from "./onboarding.jsx";

/**
 * The chat default comes from offering priority (CL-8781), never provider-list
 * order. The transport below is a mock — no network, no hub, no keychain.
 */
function fakeTransport(resolved: ResolvedModel[], vendors: unknown[] = defaultVendors()): {
  transport: Transport;
  calls: { method: string; path: string }[];
} {
  const calls: { method: string; path: string }[] = [];
  const page = (data: unknown[]) => ({ data, nextCursor: null });
  const transport: Transport = {
    fetch: async <T>(method: string, path: string): Promise<T> => {
      calls.push({ method, path });
      if (method === "GET" && path === "/api/me") return { id: "u1" } as T;
      if (method === "GET" && path.startsWith("/api/me/principals")) {
        return page([
          {
            principalId: "p1",
            tenantId: "t1",
            tenantSlug: "solutions-builder",
            kind: "user",
            status: "active",
          },
        ]) as T;
      }
      if (method === "GET" && path === "/api/tenants/t1/models") return resolved as T;
      if (method === "GET" && path.startsWith("/api/tenants/t1/catalog/providers")) {
        return page([
          {
            id: "mp-1",
            name: "Anthropic",
            plugin: "anthropic",
            baseURL: "https://api.anthropic.com",
            credentialId: "c1",
            disabled: false,
          },
        ]) as T;
      }
      if (method === "GET" && path.startsWith("/api/tenants/t1/providers")) return page(vendors) as T;
      throw new Error(`unexpected fetch ${method} ${path}`);
    },
    subscribe: () => () => {},
  };
  return { transport, calls };
}

function defaultVendors(): unknown[] {
  return [
    {
      id: "p-1",
      name: "Anthropic",
      plugin: "anthropic",
      apiBaseUrl: null,
      metadata: { label: "Anthropic" },
    },
  ];
}

function offering(providerId: string, providerName: string, priority: number) {
  return { providerId, providerName, priority };
}

describe("listWorkspaceResolvedModels", () => {
  test("reads the resolved catalog off GET /api/tenants/:id/models", async () => {
    const resolved: ResolvedModel[] = [
      { canonicalName: "claude-opus-5", offerings: [offering("mp-1", "Anthropic", 0)] },
    ];
    const { transport, calls } = fakeTransport(resolved);
    await expect(listWorkspaceResolvedModels(transport, "t1")).resolves.toEqual(resolved);
    expect(calls.some((call) => call.method === "GET" && call.path === "/api/tenants/t1/models")).toBe(true);
  });
});

describe("chat default from offering priority", () => {
  test("the lowest-priority offering wins even when its model is not first", async () => {
    // Sonnet leads the resolved list, but opus-5 carries the lower priority —
    // a list-order default would answer sonnet.
    const { transport, calls } = fakeTransport([
      { canonicalName: "claude-sonnet-5", offerings: [offering("mp-1", "Anthropic", 5)] },
      { canonicalName: "claude-opus-5", offerings: [offering("mp-1", "Anthropic", 0)] },
    ]);
    await expect(resolveActiveModel(transport)).resolves.toEqual({
      canonicalName: "claude-opus-5",
      providerLabel: "Anthropic",
    });
    // The raw offerings/models tables are never consulted — the resolved
    // reader is the only catalog source for the default.
    expect(
      calls.some((call) => call.path.includes("/catalog/offerings") || call.path.includes("/catalog/models")),
    ).toBe(false);
  });

  test("falls back to the model-provider name when no vendor label matches", async () => {
    const { transport } = fakeTransport(
      [{ canonicalName: "claude-opus-5", offerings: [offering("mp-1", "Anthropic", 0)] }],
      [],
    );
    await expect(resolveActiveModel(transport)).resolves.toEqual({
      canonicalName: "claude-opus-5",
      providerLabel: "Anthropic",
    });
  });

  test("resolves to nothing when the resolved catalog is empty", async () => {
    const { transport } = fakeTransport([]);
    await expect(resolveActiveModel(transport)).resolves.toBeNull();
  });
});

describe("needsModelChoice", () => {
  test("a provider with a selected model never triggers the model step", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: "model-a", models: ["model-a", "model-b"] })).toBe(false);
  });

  test("a ready provider with an unmade multi-model choice still does", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: null, models: ["model-a", "model-b"] })).toBe(true);
  });

  test("a single-model provider does not", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: null, models: ["model-a"] })).toBe(false);
  });

  test("a provider that is not ready does not", () => {
    expect(needsModelChoice({ status: "error", selectedModel: null, models: ["model-a", "model-b"] })).toBe(false);
  });
});

describe("staleAnthropicBase", () => {
  test("an Anthropic row connected before 9b1de80d carries a /v1 base that must go", () => {
    expect(staleAnthropicBase("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(staleAnthropicBase("anthropic", "https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
  });
  test("the fixed base, and every other vendor's /v1 base, are left alone", () => {
    expect(staleAnthropicBase("anthropic", "https://api.anthropic.com")).toBeNull();
    expect(staleAnthropicBase("openai", "https://api.openai.com/v1")).toBeNull();
    expect(staleAnthropicBase("openai-compatible", "http://localhost:11434/v1")).toBeNull();
    expect(staleAnthropicBase("anthropic", null)).toBeNull();
  });
});
