/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Transport.fetch<T> is a generic interface method; mock implementations must use `as T` to satisfy the return type contract */
import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { seedCatalog, seededVendorSpecs } from "./catalog-seed.js";
import type { HubCredential, HubModel, HubModelProvider, HubOffering, HubProvider } from "./hub.js";
import { upsertApiKeyProvider } from "./provider-connect.js";

const SCOPE = "ten_workspace";

type FetchCall = { method: string; path: string; body?: unknown };

function createMockTransport(fetchHandler: (call: FetchCall) => unknown) {
  const calls: FetchCall[] = [];
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const call = { method, path, body };
      calls.push(call);
      return fetchHandler(call) as T;
    },
    subscribe(): () => void {
      throw new Error("subscribe is not used by catalog-seed");
    },
  };
  return { transport, calls };
}

function page<T>(items: T[]) {
  return { data: items, nextCursor: null };
}

type Store = {
  vendors: HubProvider[];
  credentials: HubCredential[];
  modelProviders: HubModelProvider[];
  models: HubModel[];
  offerings: HubOffering[];
};

/** A hub that persists rows in memory, so a seed run can be followed by a connect. */
function createStoreTransport(store: Store) {
  let nextId = 1;
  const id = (prefix: string) => `${prefix}_${nextId++}`;
  return createMockTransport((call) => {
    if (call.method === "GET" && call.path.includes("/catalog/providers?limit=100")) return page(store.modelProviders);
    if (call.method === "POST" && call.path.endsWith("/catalog/providers")) {
      const row = { id: id("modelProvider"), disabled: false, ...(call.body as object) } as HubModelProvider;
      store.modelProviders.push(row);
      return row;
    }
    if (call.method === "GET" && call.path.includes("/catalog/models?limit=100")) return page(store.models);
    if (call.method === "POST" && call.path.endsWith("/catalog/models")) {
      const row = { id: id("model"), ...(call.body as object) } as HubModel;
      store.models.push(row);
      return row;
    }
    if (call.method === "GET" && call.path.includes("/catalog/offerings?limit=100")) return page(store.offerings);
    if (call.method === "POST" && call.path.endsWith("/catalog/offerings")) {
      const row = {
        id: id("offering"),
        modelId: "",
        providerId: "",
        priority: 0,
        disabled: false,
        capabilities: [],
        quirks: null,
        ...(call.body as object),
      } as HubOffering;
      store.offerings.push(row);
      return row;
    }
    if (call.method === "GET" && call.path.includes(`/tenants/${SCOPE}/providers?limit=100`)) return page(store.vendors);
    if (call.method === "POST" && call.path.endsWith("/providers")) {
      const row = {
        id: id("provider"),
        name: "",
        plugin: "",
        apiBaseUrl: null,
        metadata: null,
        ...(call.body as object),
      } as HubProvider;
      store.vendors.push(row);
      return row;
    }
    if (call.method === "PATCH" && call.path.includes("/providers/") && !call.path.includes("/catalog/")) {
      const rowId = call.path.split("/").pop();
      const row = store.vendors.find((entry) => entry.id === rowId);
      if (!row) throw new Error(`unknown vendor ${rowId}`);
      Object.assign(row, call.body as object);
      return row;
    }
    if (call.method === "POST" && call.path.endsWith("/credentials")) {
      const row = {
        id: id("credential"),
        type: "api_key",
        status: "active",
        updatedAt: "now",
        principalId: null,
        metadata: null,
        ...(call.body as object),
      } as HubCredential;
      store.credentials.push(row);
      return row;
    }
    throw new Error(`unexpected call: ${call.method} ${call.path}`);
  });
}

function emptyStore(): Store {
  return { vendors: [], credentials: [], modelProviders: [], models: [], offerings: [] };
}

describe("seedCatalog", () => {
  test("seeds one vendor row per connect-mapped spec plus one model row per offered model", async () => {
    const store = emptyStore();
    const { transport } = createStoreTransport(store);
    const specs = seededVendorSpecs();
    expect(specs.length).toBeGreaterThan(0);

    const result = await seedCatalog(transport, SCOPE);

    expect(result.providers).toEqual(specs.map((spec) => spec.name));
    const wantedModels = [...new Set(specs.flatMap((spec) => spec.offerings.map((offering) => offering.model)))];
    expect(result.models.sort()).toEqual(wantedModels.sort());
    expect(store.vendors).toHaveLength(specs.length);
    for (const spec of specs) {
      const row = store.vendors.find((entry) => entry.name === spec.name);
      expect(row?.plugin).toBe(spec.plugin);
      expect(row?.apiBaseUrl).toBe(spec.baseURL);
      expect(row?.metadata).toMatchObject({ label: spec.label, catalogSeeded: true });
      expect((row?.metadata?.["offeringSpecs"] as unknown[]).length).toBe(spec.offerings.length);
    }
    expect(store.models.map((row) => row.canonicalName).sort()).toEqual(wantedModels.sort());
    // No attach-scoped rows: the seed writes vendors and models only.
    expect(store.modelProviders).toHaveLength(0);
    expect(store.offerings).toHaveLength(0);
  });

  test("a second run writes nothing: rows are adopted by name, never rewritten", async () => {
    const store = emptyStore();
    const first = createStoreTransport(store);
    await seedCatalog(first.transport, SCOPE);
    const before = JSON.stringify(store);

    const second = createStoreTransport(store);
    const result = await seedCatalog(second.transport, SCOPE);

    expect(second.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(false);
    expect(JSON.stringify(store)).toBe(before);
    expect(result.providers).toEqual(seededVendorSpecs().map((spec) => spec.name));
  });

  test("adopts a tenant-added vendor row and model row without touching them", async () => {
    const specs = seededVendorSpecs();
    const spec = specs[0]!;
    const store = emptyStore();
    store.vendors.push({
      id: "provider_tenant",
      name: spec.name,
      plugin: spec.plugin,
      apiBaseUrl: spec.baseURL,
      metadata: { label: "My Renamed Provider", offeringSpecs: [{ model: "custom-model", displayName: "Custom", priority: 1, capabilities: [], quirks: {} }] },
    });
    const seededModel = spec.offerings[0]!.model;
    store.models.push({ id: "model_tenant", canonicalName: seededModel, displayName: "My Renamed Model" });

    const { transport, calls } = createStoreTransport(store);
    await seedCatalog(transport, SCOPE);

    // The tenant's rows win: no rewrite, no duplicate.
    expect(store.vendors.filter((row) => row.name === spec.name)).toHaveLength(1);
    expect(store.vendors.find((row) => row.name === spec.name)?.metadata).toMatchObject({ label: "My Renamed Provider" });
    expect(store.models.filter((row) => row.canonicalName === seededModel)).toHaveLength(1);
    expect(store.models.find((row) => row.canonicalName === seededModel)?.displayName).toBe("My Renamed Model");
    expect(calls.some((call) => call.method === "PATCH" && call.path.includes("/providers/"))).toBe(false);
  });

  test("backfills the offering snapshot onto a pre-seed vendor row, preserving its metadata", async () => {
    const specs = seededVendorSpecs();
    const spec = specs[0]!;
    const store = emptyStore();
    store.vendors.push({
      id: "provider_legacy",
      name: spec.name,
      plugin: spec.plugin,
      apiBaseUrl: spec.baseURL,
      metadata: { label: "Connected Before The Seed", tenantNote: "keep me" },
    });

    const { transport, calls } = createStoreTransport(store);
    await seedCatalog(transport, SCOPE);

    const row = store.vendors.find((entry) => entry.name === spec.name);
    expect(row?.metadata).toMatchObject({ label: "Connected Before The Seed", tenantNote: "keep me", catalogSeeded: true });
    expect((row?.metadata?.["offeringSpecs"] as unknown[]).length).toBe(spec.offerings.length);
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/providers") && (call.body as { name?: string }).name === spec.name)).toBe(false);
  });

  test("every call stays inside the workspace tenant scope: zero project rows", async () => {
    const store = emptyStore();
    const { transport, calls } = createStoreTransport(store);
    await seedCatalog(transport, SCOPE);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.path.includes(`/tenants/${SCOPE}/`)).toBe(true);
    }
    expect(calls.some((call) => /\/tenants\/(?!ten_workspace)[^/]+\//.test(call.path))).toBe(false);
  });

  test("a connect after the seed materializes offerings from the snapshot and writes no model rows", async () => {
    const store = emptyStore();
    const seed = createStoreTransport(store);
    await seedCatalog(seed.transport, SCOPE);

    const specs = seededVendorSpecs();
    const spec = specs[0]!;
    const { transport, calls } = createStoreTransport(store);
    await upsertApiKeyProvider(transport, SCOPE, {
      providerId: spec.name,
      label: spec.label,
      plugin: spec.plugin as "anthropic",
      baseURL: spec.baseURL,
      apiKey: "sk-test",
    });

    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/catalog/models"))).toBe(false);
    const offeringPosts = calls.filter((call) => call.method === "POST" && call.path.endsWith("/catalog/offerings"));
    expect(offeringPosts).toHaveLength(spec.offerings.length);
    for (const wanted of spec.offerings) {
      const modelRow = store.models.find((row) => row.canonicalName === wanted.model);
      const post = offeringPosts.find((call) => (call.body as { modelId: string }).modelId === modelRow?.id);
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({ priority: wanted.priority, capabilities: wanted.capabilities });
    }
  });
});
