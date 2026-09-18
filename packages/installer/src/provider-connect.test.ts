/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Transport.fetch<T> is a generic interface method; mock implementations must use `as T` to satisfy the return type contract */
import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import {
  disconnectProvider,
  registerProviderModels,
  selectModel,
  setProviderOrder,
  upsertApiKeyProvider,
  upsertOAuthProvider,
} from "./provider-connect.js";
import type { HubCredential, HubModel, HubModelProvider, HubOffering, HubProvider } from "./hub.js";

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
      throw new Error("subscribe is not used by provider-connect");
    },
  };
  return { transport, calls };
}

function page<T>(items: T[]) {
  return { data: items, nextCursor: null };
}

describe("upsertApiKeyProvider", () => {
  test("creates the vendor provider, credential and model provider fresh", async () => {
    const providers: HubProvider[] = [];
    const credentials: HubCredential[] = [];
    const modelProviders: HubModelProvider[] = [];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/providers?limit=100")) return page(modelProviders);
      if (call.method === "POST" && call.path.endsWith("/catalog/providers")) {
        const row = { id: "modelProvider_1", disabled: false, ...(call.body as object) } as HubModelProvider;
        modelProviders.push(row);
        return row;
      }
      if (call.method === "GET" && call.path.includes("/tenants/ten_workspace/providers?limit=100")) return page(providers);
      if (call.method === "POST" && call.path.endsWith("/providers")) {
        const row = {
          id: "provider_1",
          name: "",
          plugin: "",
          apiBaseUrl: null,
          metadata: null,
          ...(call.body as object),
        } as HubProvider;
        providers.push(row);
        return row;
      }
      if (call.method === "POST" && call.path.endsWith("/credentials")) {
        const row = {
          id: "credential_1",
          type: "api_key",
          status: "active",
          updatedAt: "now",
          principalId: null,
          metadata: null,
          ...(call.body as object),
        } as HubCredential;
        credentials.push(row);
        return row;
      }
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    const result = await upsertApiKeyProvider(transport, SCOPE, {
      providerId: "anthropic",
      label: "Anthropic",
      plugin: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
    });

    expect(result).toEqual({
      vendorProviderId: "provider_1",
      credentialId: "credential_1",
      modelProviderId: "modelProvider_1",
    });
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/credentials"))).toBe(true);
    expect(
      calls.some(
        (c) => c.method === "POST" && c.path.endsWith("/catalog/providers") && (c.body as { credentialId: string }).credentialId === "credential_1",
      ),
    ).toBe(true);
  });

  test("rotates the existing credential in place on a 409 name clash", async () => {
    const existingCredential: HubCredential = {
      id: "credential_existing",
      providerId: "provider_1",
      name: "provider:anthropic",
      type: "api_key",
      status: "error",
      principalId: null,
      metadata: null,
      updatedAt: "then",
    };
    const existingModelProvider: HubModelProvider = {
      id: "modelProvider_1",
      name: "anthropic",
      plugin: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      credentialId: "credential_existing",
      disabled: false,
    };
    const vendorProvider: HubProvider = {
      id: "provider_1",
      name: "anthropic",
      plugin: "anthropic",
      apiBaseUrl: "https://api.anthropic.com/v1",
      metadata: null,
    };

    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.includes("/tenants/ten_workspace/providers?limit=100")) return page([vendorProvider]);
      if (call.method === "POST" && call.path.endsWith("/credentials")) {
        throw new ApiError(409, "conflict", "Credential name already exists in this tenant");
      }
      if (call.method === "GET" && call.path.includes("/credentials/resolve/")) return existingCredential;
      if (call.method === "PATCH" && call.path.endsWith(`/credentials/${existingCredential.id}`)) {
        return { ...existingCredential, ...(call.body as object), status: "active" };
      }
      if (call.method === "GET" && call.path.endsWith("/catalog/providers?limit=100")) return page([existingModelProvider]);
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    const result = await upsertApiKeyProvider(transport, SCOPE, {
      providerId: "anthropic",
      label: "Anthropic",
      plugin: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-rotated",
    });

    expect(result.credentialId).toBe("credential_existing");
    expect(result.modelProviderId).toBe("modelProvider_1");
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith(`/credentials/${existingCredential.id}`))).toBe(true);
  });
});

describe("registerProviderModels", () => {
  test("creates a model and offering per discovered name, disables offerings that dropped out", async () => {
    const models: HubModel[] = [{ id: "model_keep", canonicalName: "claude-keep", displayName: null }];
    const offerings: HubOffering[] = [
      { id: "offering_keep", modelId: "model_keep", providerId: "mp_1", priority: 0, capabilities: [], quirks: null, disabled: false },
      { id: "offering_drop", modelId: "model_drop", providerId: "mp_1", priority: 1, capabilities: [], quirks: null, disabled: false },
    ];
    models.push({ id: "model_drop", canonicalName: "claude-drop", displayName: null });

    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/models?limit=100")) return page(models);
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "POST" && call.path.endsWith("/catalog/models")) {
        const row = { id: "model_new", ...(call.body as object) } as HubModel;
        return row;
      }
      if (call.method === "POST" && call.path.endsWith("/catalog/offerings")) {
        return {
          id: "offering_new",
          modelId: "",
          providerId: "",
          priority: 0,
          disabled: false,
          capabilities: [],
          quirks: null,
          ...(call.body as object),
        } as HubOffering;
      }
      if (call.method === "PATCH" && call.path.includes("/catalog/offerings/")) {
        return { ...(call.body as object) };
      }
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    await registerProviderModels(transport, SCOPE, {
      modelProviderId: "mp_1",
      canonicalNames: ["claude-keep", "claude-new"],
    });

    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/catalog/models"))).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.path.endsWith("/catalog/offerings") &&
          (c.body as { modelId: string }).modelId === "model_new",
      ),
    ).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/catalog/offerings/offering_drop"))).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/catalog/offerings/offering_keep"))).toBe(false);
  });
});

describe("setProviderOrder", () => {
  test("rewrites basePriority per provider while preserving within-provider offsets", async () => {
    const offerings: HubOffering[] = [
      { id: "o1", modelId: "m1", providerId: "second", priority: 5000, capabilities: [], quirks: null, disabled: false },
      { id: "o2", modelId: "m2", providerId: "first", priority: 3001, capabilities: [], quirks: null, disabled: false },
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "PATCH") return {};
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    await setProviderOrder(transport, SCOPE, ["first", "second"]);

    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches.find((c) => c.path.endsWith("/o2"))?.body).toEqual({ priority: 1 });
    expect(patches.find((c) => c.path.endsWith("/o1"))?.body).toEqual({ priority: 1000 });
  });
});

describe("selectModel", () => {
  test("disables every offering but the chosen one, and clearing re-enables all", async () => {
    const models: HubModel[] = [
      { id: "m1", canonicalName: "a", displayName: null },
      { id: "m2", canonicalName: "b", displayName: null },
    ];
    const offerings: HubOffering[] = [
      { id: "o1", modelId: "m1", providerId: "mp", priority: 0, capabilities: [], quirks: null, disabled: false },
      { id: "o2", modelId: "m2", providerId: "mp", priority: 1, capabilities: [], quirks: null, disabled: false },
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/models?limit=100")) return page(models);
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "PATCH") return {};
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    await selectModel(transport, SCOPE, "mp", "a");

    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path.endsWith("/o2")).toBe(true);
    expect(patches[0]!.body).toEqual({ disabled: true });
  });
});

describe("disconnectProvider", () => {
  test("deletes the model provider then its credential", async () => {
    const modelProviders: HubModelProvider[] = [
      { id: "mp", name: "anthropic", plugin: "anthropic", baseURL: "u", credentialId: "cred_1", disabled: false },
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/providers?limit=100")) return page(modelProviders);
      if (call.method === "DELETE") return undefined;
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    await disconnectProvider(transport, SCOPE, "mp");

    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/catalog/providers/mp"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/credentials/cred_1"))).toBe(true);
  });

  test("a credential still in use (409) does not fail the disconnect", async () => {
    const modelProviders: HubModelProvider[] = [
      { id: "mp", name: "anthropic", plugin: "anthropic", baseURL: "u", credentialId: "cred_1", disabled: false },
    ];
    const { transport } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/providers?limit=100")) return page(modelProviders);
      if (call.method === "DELETE" && call.path.endsWith("/catalog/providers/mp")) return undefined;
      if (call.method === "DELETE" && call.path.endsWith("/credentials/cred_1")) {
        throw new ApiError(409, "conflict", "Credential is in use by a model provider");
      }
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    await expect(disconnectProvider(transport, SCOPE, "mp")).resolves.toBeUndefined();
  });
});

describe("upsertOAuthProvider", () => {
  test("stores the exchanged token pair as an oauth_token credential", async () => {
    const providers: HubProvider[] = [];
    const credentials: HubCredential[] = [];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.includes("/tenants/ten_workspace/providers?limit=100")) return page(providers);
      if (call.method === "POST" && call.path.endsWith("/providers")) {
        const row = { id: "provider_1", name: "", plugin: "", apiBaseUrl: null, metadata: null, ...(call.body as object) } as HubProvider;
        providers.push(row);
        return row;
      }
      if (call.method === "POST" && call.path.endsWith("/credentials")) {
        const row = {
          id: "credential_1",
          status: "active",
          updatedAt: "now",
          principalId: null,
          metadata: null,
          ...(call.body as object),
        } as HubCredential;
        credentials.push(row);
        return row;
      }
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    const result = await upsertOAuthProvider(transport, SCOPE, {
      providerId: "codex-oauth",
      label: "ChatGPT (Codex)",
      tokens: { access: "at_1", refresh: "rt_1", expiresAt: 1_700_000_000_000 },
    });

    expect(result).toEqual({ vendorProviderId: "provider_1", credentialId: "credential_1" });
    expect(credentials[0]).toMatchObject({
      type: "oauth_token",
      secret: "at_1",
      refreshSecret: "rt_1",
      name: "provider:codex-oauth",
    });
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/credentials"))).toBe(true);
  });

  test("rotates the same credential on reconnect (409)", async () => {
    const providers: HubProvider[] = [
      { id: "provider_1", name: "xai-oauth", plugin: "openai-compatible", apiBaseUrl: "", metadata: { label: "xAI (Grok)" } },
    ];
    const existing: HubCredential = {
      id: "credential_1",
      providerId: "provider_1",
      name: "provider:xai-oauth",
      type: "oauth_token",
      status: "active",
      principalId: null,
      metadata: null,
      updatedAt: "before",
    };
    const { transport } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.includes("/tenants/ten_workspace/providers?limit=100")) return page(providers);
      if (call.method === "POST" && call.path.endsWith("/credentials")) {
        throw new ApiError(409, "conflict", "Credential already exists");
      }
      if (call.method === "GET" && call.path.includes("/credentials/resolve/")) return existing;
      if (call.method === "PATCH" && call.path.endsWith("/credentials/credential_1")) {
        return { ...existing, ...(call.body as object) };
      }
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });

    const result = await upsertOAuthProvider(transport, SCOPE, {
      providerId: "xai-oauth",
      label: "xAI (Grok)",
      tokens: { access: "at_2", refresh: "rt_2" },
    });

    expect(result).toEqual({ vendorProviderId: "provider_1", credentialId: "credential_1" });
  });
});
