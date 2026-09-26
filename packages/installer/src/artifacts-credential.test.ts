import { describe, expect, test } from "bun:test";
import { ensureProvider, WORKFLOW_ARTIFACTS_PROVIDER_NAME } from "./artifacts-credential.js";
import type { HubProvider } from "./hub.js";

type ProviderCatalog = Parameters<typeof ensureProvider>[0];

const ORIGIN = "http://127.0.0.1:4310";

function fakeCatalog(rows: HubProvider[]) {
  const patches: { id: string; input: unknown }[] = [];
  const creates: unknown[] = [];
  const catalog: ProviderCatalog = {
    providers: async () => rows,
    createProvider: async (input) => {
      creates.push(input);
      const row: HubProvider = {
        id: `provider_${String(rows.length + 1)}`,
        name: input.name,
        plugin: input.plugin,
        apiBaseUrl: input.apiBaseUrl ?? null,
        metadata: null,
      };
      rows.push(row);
      return row;
    },
    patchProvider: async (id, input) => {
      patches.push({ id, input });
      const row = rows.find((candidate) => candidate.id === id)!;
      const patched = { ...row, apiBaseUrl: input.apiBaseUrl ?? row.apiBaseUrl };
      rows.splice(rows.indexOf(row), 1, patched);
      return patched;
    },
  };
  return { catalog, patches, creates };
}

function row(apiBaseUrl: string | null): HubProvider {
  return { id: "provider_existing", name: WORKFLOW_ARTIFACTS_PROVIDER_NAME, plugin: "http", apiBaseUrl, metadata: null };
}

describe("ensureProvider", () => {
  test("refuses an empty origin instead of creating a provider the hub cannot launch against", async () => {
    const { catalog, creates } = fakeCatalog([]);
    await expect(ensureProvider(catalog, "")).rejects.toThrow(/needs the hub's origin/);
    await expect(ensureProvider(catalog, "   ")).rejects.toThrow(/needs the hub's origin/);
    expect(creates).toHaveLength(0);
  });

  test("creates the provider at the origin when none exists", async () => {
    const { catalog, creates, patches } = fakeCatalog([]);
    const provider = await ensureProvider(catalog, ORIGIN);
    expect(provider.apiBaseUrl).toBe(ORIGIN);
    expect(creates).toEqual([{ name: WORKFLOW_ARTIFACTS_PROVIDER_NAME, plugin: "http", apiBaseUrl: ORIGIN }]);
    expect(patches).toHaveLength(0);
  });

  test("repairs an existing row whose apiBaseUrl is empty", async () => {
    const { catalog, creates, patches } = fakeCatalog([row("")]);
    const provider = await ensureProvider(catalog, ORIGIN);
    expect(provider.id).toBe("provider_existing");
    expect(provider.apiBaseUrl).toBe(ORIGIN);
    expect(patches).toEqual([{ id: "provider_existing", input: { apiBaseUrl: ORIGIN } }]);
    expect(creates).toHaveLength(0);
  });

  test("repairs an existing row pinned to a different origin", async () => {
    const { catalog, patches } = fakeCatalog([row("http://127.0.0.1:1")]);
    const provider = await ensureProvider(catalog, ORIGIN);
    expect(provider.apiBaseUrl).toBe(ORIGIN);
    expect(patches).toHaveLength(1);
  });

  test("leaves a correct row untouched", async () => {
    const { catalog, creates, patches } = fakeCatalog([row(ORIGIN)]);
    const provider = await ensureProvider(catalog, ORIGIN);
    expect(provider.id).toBe("provider_existing");
    expect(patches).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });
});
