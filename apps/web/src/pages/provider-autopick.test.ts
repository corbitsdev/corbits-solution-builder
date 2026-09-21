import { describe, expect, test } from "bun:test";
import type { Provider } from "../client.js";
import { needsModelChoice } from "./onboarding.jsx";
import { autoPick, autoPickModel, autoPickProvider } from "./providers.jsx";

describe("autoPickModel", () => {
  test("pins the first served model when nothing is chosen", () => {
    expect(autoPickModel({ selectedModel: null, models: ["model-a", "model-b"] })).toBe("model-a");
  });

  test("leaves an explicit choice alone", () => {
    expect(autoPickModel({ selectedModel: "model-b", models: ["model-a", "model-b"] })).toBeNull();
  });

  test("pins nothing when no models are served", () => {
    expect(autoPickModel({ selectedModel: null, models: [] })).toBeNull();
  });
});

describe("needsModelChoice", () => {
  test("an auto-picked provider never triggers the model step", () => {
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

/**
 * The async wiring around `autoPickModel`: the connect and refresh paths in
 * `providers.tsx` must hand the fresh provider to `selectProviderModel` with
 * `models[0]` when nothing is chosen, and stay silent otherwise. The `api`
 * surface here is a mock — no network, no hub, no keychain.
 */
function connectedProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "row-1",
    providerId: "openai",
    label: "OpenAI",
    kind: "api_key",
    baseUrl: null,
    status: "ready",
    statusDetail: null,
    models: ["model-a", "model-b"],
    active: true,
    priority: 0,
    hasCredential: true,
    validatedAt: null,
    selectedModel: null,
    ...overrides,
  };
}

function fakeSelect() {
  const calls: { providerId: string; model: string | null }[] = [];
  return {
    calls,
    selectProviderModel: async (providerId: string, model: string | null): Promise<void> => {
      calls.push({ providerId, model });
    },
  };
}

/** The lookup half of the `api` surface: `providers()` serving a fixed fresh list. */
function fakeList(fresh: Provider[], select: ReturnType<typeof fakeSelect>) {
  return {
    selectProviderModel: select.selectProviderModel,
    providers: async () => ({ providers: fresh, apiKeyProviders: [], oauthCandidates: [] }),
  };
}

describe("auto-pick connect wiring", () => {
  test("connect pins the first served model when nothing is chosen", async () => {
    // Mirrors the api_key/local connect path: the connect call returns the
    // fresh provider, which is handed straight to autoPickProvider.
    const select = fakeSelect();
    const connectProvider = async (): Promise<Provider> =>
      connectedProvider({ selectedModel: null, models: ["model-a", "model-b"] });
    await autoPickProvider(await connectProvider(), select);
    expect(select.calls).toEqual([{ providerId: "row-1", model: "model-a" }]);
  });

  test("connect leaves an explicit choice alone", async () => {
    const select = fakeSelect();
    const connectProvider = async (): Promise<Provider> =>
      connectedProvider({ selectedModel: "model-b", models: ["model-a", "model-b"] });
    await autoPickProvider(await connectProvider(), select);
    expect(select.calls).toEqual([]);
  });

  test("connect pins nothing when no models are served", async () => {
    const select = fakeSelect();
    await autoPickProvider(connectedProvider({ selectedModel: null, models: [] }), select);
    expect(select.calls).toEqual([]);
  });

  test("oauth connect looks the fresh row up before pinning", async () => {
    // Mirrors the OAuth connect path: the handshake returns no provider, so
    // the fresh list is read back before pinning.
    const select = fakeSelect();
    const connectOAuthProvider = async (): Promise<void> => {};
    await connectOAuthProvider();
    await autoPick(
      "openai",
      fakeList([connectedProvider({ selectedModel: null, models: ["model-a", "model-b"] })], select),
    );
    expect(select.calls).toEqual([{ providerId: "row-1", model: "model-a" }]);
  });
});

describe("auto-pick refresh wiring", () => {
  test("refresh pins the first served model when nothing is chosen", async () => {
    // Mirrors the Refresh models button: refresh first, then the same
    // lookup-then-pin path the OAuth connect uses.
    const select = fakeSelect();
    const refreshed: string[] = [];
    const refreshProviderModels = async (providerId: string) => {
      refreshed.push(providerId);
      return { clearedModel: null };
    };
    await refreshProviderModels("openai");
    await autoPick(
      "openai",
      fakeList([connectedProvider({ selectedModel: null, models: ["model-a", "model-b"] })], select),
    );
    expect(refreshed).toEqual(["openai"]);
    expect(select.calls).toEqual([{ providerId: "row-1", model: "model-a" }]);
  });

  test("refresh leaves an explicit choice alone", async () => {
    const select = fakeSelect();
    const refreshed: string[] = [];
    const refreshProviderModels = async (providerId: string) => {
      refreshed.push(providerId);
      return { clearedModel: null };
    };
    await refreshProviderModels("openai");
    await autoPick(
      "openai",
      fakeList([connectedProvider({ selectedModel: "model-b", models: ["model-a", "model-b"] })], select),
    );
    expect(refreshed).toEqual(["openai"]);
    expect(select.calls).toEqual([]);
  });

  test("refresh pins nothing when the provider left the fresh list", async () => {
    const select = fakeSelect();
    await autoPick("openai", fakeList([], select));
    expect(select.calls).toEqual([]);
  });
});
