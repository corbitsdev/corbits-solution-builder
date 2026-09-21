import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import {
  listResolvedCatalog,
  makeResolvedDefault,
  type ResolvedCatalogEntry,
} from "./provider-catalog.js";

/**
 * The Settings Inference list (CL-8782) merges `GET /models` with the raw
 * catalog tables. The transport below is a mock — no network, no hub, no
 * keychain.
 */
const CHAT = ["plain-text", "plain-text-streaming", "tool-call"];

type FetchCall = { method: string; path: string; body?: unknown };

function fakeTransport(options: {
  resolved: ResolvedCatalogEntry[];
  rawOfferings?: unknown[];
  rawModels?: unknown[];
  principals?: unknown[];
}): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const page = (data: unknown[]) => ({ data, nextCursor: null });
  const transport: Transport = {
    fetch: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/me") return { id: "u1" } as T;
      if (method === "GET" && path.startsWith("/api/me/principals")) {
        return page(
          options.principals ?? [
            {
              principalId: "p1",
              tenantId: "t1",
              tenantSlug: "solutions-builder",
              kind: "user",
              status: "active",
            },
          ],
        ) as T;
      }
      if (method === "GET" && path === "/api/tenants/t1/models") return options.resolved as T;
      if (method === "GET" && path.startsWith("/api/tenants/t1/catalog/models")) {
        return page(options.rawModels ?? []) as T;
      }
      if (method === "GET" && path.startsWith("/api/tenants/t1/catalog/offerings")) {
        return page(options.rawOfferings ?? []) as T;
      }
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
      if (method === "GET" && path.startsWith("/api/tenants/t1/credentials")) {
        return page([
          {
            id: "c1",
            providerId: "p-1",
            name: "key",
            type: "api_key",
            status: "active",
            principalId: null,
            metadata: null,
            updatedAt: "now",
          },
        ]) as T;
      }
      if (method === "PATCH") return { ok: true } as T;
      throw new Error(`unexpected fetch ${method} ${path}`);
    },
    subscribe: () => () => {},
  };
  return { transport, calls };
}

function entry(
  id: string,
  canonicalName: string,
  offerings: { offeringId: string; priority: number; capabilities?: string[] }[],
): ResolvedCatalogEntry {
  return {
    id,
    canonicalName,
    displayName: canonicalName,
    offerings: offerings.map((offering) => ({
      offeringId: offering.offeringId,
      providerId: "mp-1",
      providerName: "Anthropic",
      priority: offering.priority,
      capabilities: offering.capabilities ?? CHAT,
    })),
  };
}

describe("listResolvedCatalog", () => {
  test("rows follow the resolved response order, not priority order", async () => {
    const { transport } = fakeTransport({
      resolved: [
        entry("m-sonnet", "claude-sonnet-5", [{ offeringId: "off-sonnet", priority: 5 }]),
        entry("m-opus", "claude-opus-5", [{ offeringId: "off-opus", priority: 0 }]),
      ],
    });
    const rows = await listResolvedCatalog(transport);
    expect(rows.map((row) => row.modelId)).toEqual(["m-sonnet", "m-opus"]);
    expect(rows[0]?.isDefault).toBe(false);
    expect(rows[1]?.isDefault).toBe(true);
  });

  test("restricted models stay visible and excluded from default candidacy", async () => {
    const { transport } = fakeTransport({
      resolved: [entry("m-sonnet", "claude-sonnet-5", [{ offeringId: "off-sonnet", priority: 5 }])],
      rawModels: [
        { id: "m-sonnet", canonicalName: "claude-sonnet-5", displayName: "Sonnet" },
        { id: "m-opus", canonicalName: "claude-opus-5", displayName: "Opus" },
      ],
      rawOfferings: [
        {
          id: "off-sonnet",
          modelId: "m-sonnet",
          providerId: "mp-1",
          priority: 5,
          capabilities: CHAT,
          quirks: null,
          disabled: false,
        },
        {
          id: "off-opus",
          modelId: "m-opus",
          providerId: "mp-1",
          priority: 0,
          capabilities: CHAT,
          quirks: null,
          disabled: true,
        },
      ],
    });
    const rows = await listResolvedCatalog(transport);
    expect(rows.map((row) => row.modelId)).toEqual(["m-sonnet", "m-opus"]);
    expect(rows[1]?.restricted).toBe(true);
    expect(rows[1]?.defaultCandidate).toBe(false);
    expect(rows[1]?.isDefault).toBe(false);
    expect(rows[0]?.isDefault).toBe(true);
  });

  test("an empty catalog reads as an explicit empty list, never simulated rows", async () => {
    const { transport } = fakeTransport({ resolved: [] });
    await expect(listResolvedCatalog(transport)).resolves.toEqual([]);
  });

  test("an unseeded tenant (no workspace) reads as an empty list", async () => {
    const { transport } = fakeTransport({ resolved: [], principals: [] });
    await expect(listResolvedCatalog(transport)).resolves.toEqual([]);
  });
});

describe("makeResolvedDefault", () => {
  test("writes priority-only PATCHes through the catalog routes", async () => {
    const { transport, calls } = fakeTransport({
      resolved: [],
      rawOfferings: [
        {
          id: "off-opus",
          modelId: "m-opus",
          providerId: "mp-1",
          priority: 0,
          capabilities: CHAT,
          quirks: null,
          disabled: false,
        },
        {
          id: "off-sonnet",
          modelId: "m-sonnet",
          providerId: "mp-1",
          priority: 5,
          capabilities: CHAT,
          quirks: null,
          disabled: false,
        },
      ],
    });
    await makeResolvedDefault(transport, "m-sonnet");
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: "/api/tenants/t1/catalog/offerings/off-sonnet",
        body: { priority: 0 },
      },
      {
        method: "PATCH",
        path: "/api/tenants/t1/catalog/offerings/off-opus",
        body: { priority: 5 },
      },
    ]);
  });
});
