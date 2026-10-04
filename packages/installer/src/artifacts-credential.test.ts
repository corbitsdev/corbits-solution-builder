import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import {
  ensureProvider,
  ensureWorkflowArtifactsCredentialRow,
  registerWorkflowArtifactsBearer,
  WORKFLOW_ARTIFACTS_PROVIDER_NAME,
  workflowArtifactsCredentialName,
} from "./artifacts-credential.js";
import type { HubCredential, HubProvider } from "./hub.js";

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

const TENANT = "tnt_project";
const WORKSPACE = "tnt_ws";
const ROLE = "brainstormer";
const CREDENTIAL_NAME = workflowArtifactsCredentialName(ROLE);

function credentialRow(id: string): HubCredential {
  return {
    id,
    providerId: "provider_existing",
    name: CREDENTIAL_NAME,
    type: "other",
    status: "active",
    principalId: null,
    metadata: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeCredentialTransport(existing: HubCredential | null) {
  let credential = existing;
  const creates: unknown[] = [];
  const patches: { id: string; input: unknown }[] = [];
  const tokens: unknown[] = [];
  const transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const [pathname] = path.split("?");
      const resolve = /^\/api\/tenants\/([^/]+)\/credentials\/resolve\/(.+)$/.exec(pathname!);
      if (method === "GET" && resolve) {
        if (!credential) throw new ApiError(404, "not_found", "no such credential");
        return credential as T;
      }
      if (method === "GET" && pathname?.endsWith("/providers")) {
        return { data: [row(ORIGIN)], nextCursor: null } as T;
      }
      if (method === "POST" && pathname === `/api/tenants/${TENANT}/credentials`) {
        creates.push(body);
        credential = credentialRow("crd_created");
        return credential as T;
      }
      const patch = /^\/api\/tenants\/([^/]+)\/credentials\/([^/]+)$/.exec(pathname!);
      if (method === "PATCH" && patch) {
        patches.push({ id: patch[2]!, input: body });
        return { ...(credential ?? credentialRow(patch[2]!)), status: "active" } as T;
      }
      if (method === "POST" && pathname === `/api/tenants/${TENANT}/workflow-artifact-tokens`) {
        tokens.push(body);
        return undefined as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
  return { transport, creates, patches, tokens };
}

describe("ensureWorkflowArtifactsCredentialRow", () => {
  test("returns an existing row's id and never rotates its secret", async () => {
    const { transport, creates, patches } = fakeCredentialTransport(credentialRow("crd_existing"));
    const first = await ensureWorkflowArtifactsCredentialRow(transport, TENANT, ORIGIN, ROLE, WORKSPACE);
    const second = await ensureWorkflowArtifactsCredentialRow(transport, TENANT, ORIGIN, ROLE, WORKSPACE);
    expect(first).toBe("crd_existing");
    expect(second).toBe("crd_existing");
    expect(creates).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  test("creates the row when absent, still without a later rotate on re-ensure", async () => {
    const { transport, creates, patches } = fakeCredentialTransport(null);
    const id = await ensureWorkflowArtifactsCredentialRow(transport, TENANT, ORIGIN, ROLE, WORKSPACE);
    expect(id).toBe("crd_created");
    expect(creates).toHaveLength(1);
    expect(patches).toHaveLength(0);
    const again = await ensureWorkflowArtifactsCredentialRow(transport, TENANT, ORIGIN, ROLE, WORKSPACE);
    expect(again).toBe("crd_created");
    expect(creates).toHaveLength(1);
    expect(patches).toHaveLength(0);
  });
});

describe("registerWorkflowArtifactsBearer", () => {
  test("patches the credential secret and registers the same token for the anchor run", async () => {
    const { transport, patches, tokens } = fakeCredentialTransport(credentialRow("crd_existing"));
    await registerWorkflowArtifactsBearer(transport, TENANT, "crd_existing", "dep_1");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.id).toBe("crd_existing");
    const input = patches[0]!.input as { secret: string; status: string };
    expect(input.status).toBe("active");
    expect(input.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens).toEqual([{ token: input.secret, anchorRunId: "dep_1" }]);
  });
});
