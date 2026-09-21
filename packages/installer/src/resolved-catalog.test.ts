/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Transport.fetch<T> is a generic interface method; mock implementations must use `as T` to satisfy the return type contract */
import { describe, expect, test } from "bun:test";
import type { Transport } from "./hub.js";
import type { HubCredential, HubModel, HubModelProvider, HubOffering } from "./hub.js";
import {
  buildResolvedCatalogRows,
  makeResolvedModelDefault,
  moveResolvedModel,
  setResolvedModelRestricted,
  setResolvedModelShadowed,
  type ResolvedCatalogInput,
} from "./resolved-catalog.js";

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
      throw new Error("subscribe is not used by resolved-catalog");
    },
  };
  return { transport, calls };
}

function page<T>(items: T[]) {
  return { data: items, nextCursor: null };
}

const CHAT = ["plain-text", "plain-text-streaming", "tool-call"];
const EMBED = ["embed-text"];

function provider(id: string, name: string, credentialId: string | null, disabled = false): HubModelProvider {
  return { id, name, plugin: "anthropic", baseURL: "https://api.anthropic.com", credentialId, disabled };
}

function credential(id: string, status = "active"): HubCredential {
  return {
    id,
    providerId: "prov_anthropic",
    name: "key",
    type: "api_key",
    status,
    principalId: null,
    metadata: null,
    updatedAt: "now",
  };
}

function offering(
  id: string,
  modelId: string,
  providerId: string,
  priority: number,
  capabilities: string[] = CHAT,
  disabled = false,
): HubOffering {
  return { id, modelId, providerId, priority, capabilities, quirks: null, disabled };
}

function model(id: string, canonicalName: string): HubModel {
  return { id, canonicalName, displayName: canonicalName };
}

/** Response order is the fallback order: Sonnet first even though Opus holds priority 0. */
function fixtureInput(): ResolvedCatalogInput {
  return {
    resolved: [
      {
        id: "model_sonnet",
        canonicalName: "anthropic/sonnet",
        displayName: "Sonnet",
        offerings: [
          {
            offeringId: "off_sonnet",
            providerId: "mp_anthropic",
            providerName: "Anthropic",
            priority: 5,
            capabilities: CHAT,
          },
        ],
      },
      {
        id: "model_opus",
        canonicalName: "anthropic/opus",
        displayName: "Opus",
        offerings: [
          {
            offeringId: "off_opus",
            providerId: "mp_anthropic",
            providerName: "Anthropic",
            priority: 0,
            capabilities: CHAT,
          },
        ],
      },
    ],
    models: [model("model_sonnet", "anthropic/sonnet"), model("model_opus", "anthropic/opus")],
    offerings: [
      offering("off_sonnet", "model_sonnet", "mp_anthropic", 5),
      offering("off_opus", "model_opus", "mp_anthropic", 0),
    ],
    modelProviders: [provider("mp_anthropic", "Anthropic", "cred_1")],
    credentials: [credential("cred_1")],
  };
}

describe("buildResolvedCatalogRows", () => {
  test("rows follow resolved response order while the default badge follows min priority", () => {
    const rows = buildResolvedCatalogRows(fixtureInput());
    expect(rows.map((row) => row.modelId)).toEqual(["model_sonnet", "model_opus"]);
    expect(rows[0]?.isDefault).toBe(false);
    expect(rows[1]?.isDefault).toBe(true);
    expect(rows.every((row) => row.defaultCandidate)).toBe(true);
    expect(rows[0]?.providerNames).toEqual(["Anthropic"]);
    expect(rows[0]?.credentialConnected).toBe(true);
  });

  test("restricted rows stay visible, badged, and excluded from default candidacy", () => {
    const input = fixtureInput();
    input.resolved = input.resolved.filter((entry) => entry.id !== "model_opus");
    input.offerings = input.offerings.map((row) =>
      row.id === "off_opus" ? { ...row, disabled: true } : row,
    );
    const rows = buildResolvedCatalogRows(input);
    expect(rows.map((row) => row.modelId)).toEqual(["model_sonnet", "model_opus"]);
    const restricted = rows[1];
    expect(restricted?.restricted).toBe(true);
    expect(restricted?.defaultCandidate).toBe(false);
    expect(restricted?.isDefault).toBe(false);
    // The surviving chat row becomes the default.
    expect(rows[0]?.isDefault).toBe(true);
  });

  test("restricted chat model keeps chatCapable true", () => {
    const input = fixtureInput();
    input.resolved = input.resolved.filter((entry) => entry.id !== "model_opus");
    input.offerings = input.offerings.map((row) =>
      row.id === "off_opus" ? { ...row, disabled: true } : row,
    );
    const rows = buildResolvedCatalogRows(input);
    const restricted = rows.find((row) => row.modelId === "model_opus");
    expect(restricted?.restricted).toBe(true);
    expect(restricted?.chatCapable).toBe(true);
    expect(restricted?.defaultCandidate).toBe(false);
    expect(restricted?.isDefault).toBe(false);
  });

  test("restricted non-chat model keeps chatCapable false", () => {
    const input = fixtureInput();
    input.resolved = input.resolved.filter((entry) => entry.id !== "model_opus");
    input.offerings = input.offerings.map((row) =>
      row.id === "off_opus" ? { ...row, capabilities: EMBED, disabled: true } : row,
    );
    const rows = buildResolvedCatalogRows(input);
    const restricted = rows.find((row) => row.modelId === "model_opus");
    expect(restricted?.restricted).toBe(true);
    expect(restricted?.chatCapable).toBe(false);
  });

  test("non-chat models are badged and never chat default", () => {
    const input = fixtureInput();
    input.resolved[0] = {
      ...input.resolved[0]!,
      offerings: [{ ...input.resolved[0]!.offerings[0]!, priority: -10, capabilities: EMBED }],
    };
    input.offerings = input.offerings.map((row) =>
      row.id === "off_sonnet" ? { ...row, priority: -10, capabilities: EMBED } : row,
    );
    const rows = buildResolvedCatalogRows(input);
    expect(rows[0]?.chatCapable).toBe(false);
    expect(rows[0]?.defaultCandidate).toBe(false);
    expect(rows[0]?.isDefault).toBe(false);
    expect(rows[1]?.isDefault).toBe(true);
  });

  test("missing credential reads as boolean false, never a secret", () => {
    const input = fixtureInput();
    input.credentials = [];
    const rows = buildResolvedCatalogRows(input);
    expect(rows[0]?.credentialConnected).toBe(false);
  });
});

describe("makeResolvedModelDefault", () => {
  test("patches exactly the computeMakeDefaultPatches payloads", async () => {
    const offerings = [
      offering("off_opus", "model_opus", "mp_anthropic", 0),
      offering("off_sonnet", "model_sonnet", "mp_anthropic", 5),
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "PATCH") return { ok: true };
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });
    await makeResolvedModelDefault(transport, SCOPE, "model_sonnet");
    const patches = calls.filter((call) => call.method === "PATCH");
    // Sonnet takes priority 0; Opus shifts to 5. No disabled/opaque keys.
    expect(patches).toEqual([
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/offerings/off_sonnet`,
        body: { priority: 0 },
      },
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/offerings/off_opus`,
        body: { priority: 5 },
      },
    ]);
  });
});

describe("moveResolvedModel", () => {
  test("move down swaps head priorities with the neighbour", async () => {
    const offerings = [
      offering("off_opus", "model_opus", "mp_anthropic", 0),
      offering("off_sonnet", "model_sonnet", "mp_anthropic", 5),
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "PATCH") return { ok: true };
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });
    const moved = await moveResolvedModel(transport, SCOPE, "model_opus", "down");
    expect(moved).toBe(true);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/offerings/off_opus`,
        body: { priority: 5 },
      },
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/offerings/off_sonnet`,
        body: { priority: 0 },
      },
    ]);
  });

  test("restricted models have no rank and patch nothing", async () => {
    const offerings = [
      offering("off_opus", "model_opus", "mp_anthropic", 0),
      offering("off_sonnet", "model_sonnet", "mp_anthropic", 5, CHAT, true),
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });
    const moved = await moveResolvedModel(transport, SCOPE, "model_sonnet", "up");
    expect(moved).toBe(false);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });
});

describe("setResolvedModelRestricted", () => {
  test("restrict disables every enabled offering and nothing else", async () => {
    const offerings = [
      offering("off_opus", "model_opus", "mp_anthropic", 0),
      offering("off_opus_b", "model_opus", "mp_openai", 3),
      offering("off_sonnet", "model_sonnet", "mp_anthropic", 5),
    ];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "PATCH") return { ok: true };
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });
    const patched = await setResolvedModelRestricted(transport, SCOPE, "model_opus", true);
    expect(patched).toBe(2);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/offerings/off_opus`,
        body: { disabled: true },
      },
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/offerings/off_opus_b`,
        body: { disabled: true },
      },
    ]);
  });

  test("unrestrict re-enables every disabled offering", async () => {
    const offerings = [offering("off_opus", "model_opus", "mp_anthropic", 0, CHAT, true)];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/offerings?limit=100")) return page(offerings);
      if (call.method === "PATCH") return { ok: true };
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });
    const patched = await setResolvedModelRestricted(transport, SCOPE, "model_opus", false);
    expect(patched).toBe(1);
    expect(calls[1]).toEqual({
      method: "PATCH",
      path: `/api/tenants/${SCOPE}/catalog/offerings/off_opus`,
      body: { disabled: false },
    });
  });
});

describe("setResolvedModelShadowed", () => {
  test("writes disabled-only PATCHes against the provider rows", async () => {
    const providers = [provider("mp_anthropic", "Anthropic", "cred_1")];
    const { transport, calls } = createMockTransport((call) => {
      if (call.method === "GET" && call.path.endsWith("/catalog/providers?limit=100")) return page(providers);
      if (call.method === "PATCH") return { ok: true };
      throw new Error(`unexpected call: ${call.method} ${call.path}`);
    });
    const patched = await setResolvedModelShadowed(transport, SCOPE, ["mp_anthropic"], true);
    expect(patched).toBe(1);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: `/api/tenants/${SCOPE}/catalog/providers/mp_anthropic`,
        body: { disabled: true },
      },
    ]);
  });
});
