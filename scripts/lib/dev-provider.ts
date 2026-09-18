/**
 * Test/dev-only provider connect and mutate helpers.
 *
 * These used to be `apps/hub/src/providers.ts` exports reachable over
 * `POST /providers` and friends. That HTTP surface is gone -- the client now
 * manages a workspace's providers through the hub's own credential and
 * catalog routes directly -- but smoke scripts and seeds still need a fast,
 * in-process way to stand up a connected provider as a fixture. This is that
 * fixture, not a preserved host route: nothing here is mounted on the API.
 */
import { HostError, notFound } from "../../apps/hub/src/errors.js";
import { forgetAllExecutions } from "../../apps/hub/src/lifecycle-run.js";
import {
  registerProviderCatalog,
  getCatalogProvider,
  credentialSecretFor,
  touchCredentialValidated,
  setCatalogProviderPriority,
  setCatalogSelectedModel,
  disconnectCatalogProvider,
  upsertCredential,
  type Plugin,
} from "../../apps/hub/src/catalog.js";
import { listProviders, type ProviderSummary } from "../../apps/hub/src/providers.js";
import { XAI_API_KEY_BASE_URL } from "@corbits/xai-provider";
import type { ProviderConnectRequest } from "../../apps/hub/src/domain.js";

const CATALOG = {
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    probe: "/models",
    header: (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    probe: "/models",
    header: (key: string) => ({ authorization: `Bearer ${key}` }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    probe: "/models",
    header: (key: string) => ({ authorization: `Bearer ${key}` }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
  xai: {
    label: "xAI (API key)",
    baseUrl: XAI_API_KEY_BASE_URL,
    probe: "/models",
    header: (key: string) => ({ authorization: `Bearer ${key}` }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
  compatible: {
    label: "OpenAI-compatible endpoint",
    baseUrl: "",
    probe: "/models",
    header: (key: string) => ({ authorization: `Bearer ${key}` }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
} as const;

const PLUGINS: Record<string, Plugin> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openai-compatible",
  xai: "openai-compatible",
  compatible: "openai-compatible",
  local: "openai-compatible",
};

const LOCAL_PROVIDER_ID = "local";
const PROBE_TIMEOUT_MS = 10_000;

function catalogChanged(): void {
  forgetAllExecutions();
}

export function localEndpointBase(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : new URL("/v1", root).toString().replace(/\/+$/, "");
}

async function validateLocalEndpoint(baseUrl: string): Promise<{ models: string[]; baseUrl: string }> {
  const base = localEndpointBase(baseUrl);
  const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) {
    throw new HostError("provider_unavailable", `The local endpoint answered ${response.status}.`, {}, true);
  }
  const body = (await response.json()) as { data?: { id: string }[] };
  const models = (body.data ?? []).map((row) => row.id);
  if (models.length === 0) {
    throw new HostError("provider_unavailable", "That endpoint serves no models.", {}, true);
  }
  return { models, baseUrl: base };
}

async function validateApiKey(providerId: keyof typeof CATALOG, secret: string, baseUrlOverride?: string) {
  const entry = CATALOG[providerId];
  const base = baseUrlOverride?.replace(/\/+$/, "") || entry.baseUrl;
  if (!base) throw new HostError("validation_failed", "That provider needs a base URL.");
  const response = await fetch(`${base}${entry.probe}`, {
    headers: entry.header(secret),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new HostError("not_authorized", `${entry.label} rejected that key.`);
  }
  if (!response.ok) {
    throw new HostError("provider_unavailable", `${entry.label} answered ${response.status}.`, {}, true);
  }
  return entry.models((await response.json()) as { data?: { id: string }[] });
}

export async function connectProvider(request: ProviderConnectRequest): Promise<ProviderSummary> {
  if (request.kind === "oauth") {
    throw new HostError("validation_failed", "OAuth is not a fixture this helper connects.");
  }

  if (request.kind === "local_endpoint") {
    if (!request.baseUrl) throw new HostError("validation_failed", "A local endpoint needs a base URL.");
    const { models, baseUrl } = await validateLocalEndpoint(request.baseUrl);
    const priority = (await listProviders()).length;
    const link = await upsertCredential({
      providerId: LOCAL_PROVIDER_ID,
      label: request.label,
      kind: "local_endpoint",
      baseUrl,
    });
    catalogChanged();
    await registerProviderCatalog({
      providerId: LOCAL_PROVIDER_ID,
      label: request.label,
      plugin: PLUGINS[LOCAL_PROVIDER_ID] ?? "openai-compatible",
      baseUrl,
      credentialId: link.id,
      models,
      priority,
    });
    await touchCredentialValidated(LOCAL_PROVIDER_ID);
    return (await listProviders()).find((entry) => entry.providerId === LOCAL_PROVIDER_ID)!;
  }

  if (typeof request.secret === "string") request = { ...request, secret: request.secret.trim() };
  if (!request.secret) throw new HostError("validation_failed", "An API key connection needs a key.");
  if (!(request.providerId in CATALOG)) {
    throw new HostError("validation_failed", `Unsupported provider: ${request.providerId}.`);
  }
  const providerId = request.providerId as keyof typeof CATALOG;
  const models = await validateApiKey(providerId, request.secret, request.baseUrl);
  const baseUrl = request.baseUrl?.replace(/\/+$/, "") || CATALOG[providerId].baseUrl;
  const priority = (await listProviders()).length;

  try {
    const link = await upsertCredential({
      providerId: request.providerId,
      label: request.label,
      kind: request.kind,
      secret: request.secret,
      baseUrl,
    });
    if (!link) throw new Error("the hub did not return a credential reference");
    catalogChanged();
    await registerProviderCatalog({
      providerId: request.providerId,
      label: request.label,
      plugin: PLUGINS[request.providerId] ?? "openai-compatible",
      baseUrl,
      credentialId: link.id,
      models,
      priority,
    });
  } catch (cause) {
    await disconnectCatalogProvider(request.providerId).catch(() => {});
    throw new HostError(
      "provider_unavailable",
      `${request.label} validated, but could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}`,
      {},
      true,
    );
  }

  return (await listProviders()).find((entry) => entry.providerId === request.providerId)!;
}

export async function disconnectProvider(providerId: string): Promise<void> {
  const catalogRow = await getCatalogProvider(providerId);
  if (!catalogRow) throw notFound("That provider connection");
  await disconnectCatalogProvider(providerId);
  catalogChanged();
}

export async function selectModel(providerId: string, model: string | null): Promise<ProviderSummary> {
  const catalogRow = await getCatalogProvider(providerId);
  if (!catalogRow) throw notFound("That provider connection");
  if (model !== null && !catalogRow.models.some((entry) => entry.canonicalName === model)) {
    throw new HostError("validation_failed", `${model} is not in that provider's validated catalogue.`);
  }
  await setCatalogSelectedModel(providerId, model);
  catalogChanged();
  return (await listProviders()).find((entry) => entry.providerId === providerId)!;
}

export async function setProviderOrder(providerIds: string[]): Promise<ProviderSummary[]> {
  for (const [index, providerId] of providerIds.entries()) {
    await setCatalogProviderPriority(providerId, index);
  }
  catalogChanged();
  return listProviders();
}

export async function refreshProviderModels(providerId: string): Promise<ProviderSummary> {
  const catalogRow = await getCatalogProvider(providerId);
  if (!catalogRow) throw notFound("That provider connection");
  const models =
    providerId === LOCAL_PROVIDER_ID
      ? (await validateLocalEndpoint(catalogRow.baseUrl)).models
      : await validateApiKey(
          providerId as keyof typeof CATALOG,
          (await credentialSecretFor(providerId)) ?? "",
          catalogRow.baseUrl || undefined,
        );
  catalogChanged();
  await registerProviderCatalog({
    providerId,
    label: catalogRow.label,
    plugin: catalogRow.plugin,
    baseUrl: catalogRow.baseUrl,
    credentialId: catalogRow.credentialId,
    models,
    priority: catalogRow.basePriority,
  });
  await touchCredentialValidated(providerId);
  return (await listProviders()).find((entry) => entry.providerId === providerId)!;
}

export { listProviders };
