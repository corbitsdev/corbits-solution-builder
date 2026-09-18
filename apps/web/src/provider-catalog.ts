/**
 * Connected inference: read, connected, ordered, selected, disconnected --
 * all of it through the hub's own catalog routes on the workspace tenant.
 *
 * Connecting, reordering, choosing a model and disconnecting used to be host
 * routes; the host no longer owns any of that (PR #313 deleted them). This
 * module is the client's own replacement, driven entirely by `@intx/hub-client`'s
 * `Transport` over `/hub`. A provider is defined once here, on the workspace
 * tenant -- a project inherits it through tenant ancestry, never a per-project
 * copy of its own.
 *
 * Live model discovery for a candidate key has no hub route (the hub never
 * calls out to a third-party inference endpoint on the tenant's behalf), so
 * this is also the one place that calls a provider's own `/models` listing
 * directly, before anything is written, so a bad key is never persisted.
 */
import {
  ApiError,
  catalogFor,
  disconnectProvider as disconnectProviderViaHub,
  registerProviderModels,
  resolveWorkspace,
  selectModel as selectModelViaHub,
  setProviderOrder as setProviderOrderViaHub,
  upsertApiKeyProvider,
  type HubCredential,
  type HubModel,
  type HubModelProvider,
  type HubOffering,
  type HubProvider,
  type ModelProviderPlugin,
} from "@solutions-builder/installer";
import type { Transport } from "./hub.ts";

export type ListedProvider = {
  id: string;
  providerId: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  status: string;
  statusDetail: string | null;
  models: string[];
  active: boolean;
  priority: number;
  hasCredential: boolean;
  validatedAt: string | null;
  selectedModel: string | null;
};

export const API_KEY_CONNECT_OPTIONS: ReadonlyArray<{ providerId: string; label: string; needsBaseUrl: boolean }> = [
  { providerId: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { providerId: "openai", label: "OpenAI", needsBaseUrl: false },
  { providerId: "openrouter", label: "OpenRouter", needsBaseUrl: false },
  { providerId: "xai", label: "xAI (API key)", needsBaseUrl: false },
  { providerId: "compatible", label: "OpenAI-compatible endpoint", needsBaseUrl: true },
];

export const OAUTH_CONNECT_OPTIONS: ReadonlyArray<{ providerId: string; label: string; redirectUri: string }> = [
  { providerId: "codex-oauth", label: "ChatGPT (Codex)", redirectUri: "" },
  { providerId: "xai-oauth", label: "xAI (Grok)", redirectUri: "" },
];

/**
 * First-party OpenAI `/models` mixes embeddings, speech and images into one
 * list. Anything else is taken as listed: its shape is unknown here.
 */
const NOT_A_CHAT_MODEL =
  /embedding|whisper|tts|transcribe|moderation|dall-e|sora|davinci|babbage|-instruct|realtime|audio|-image|search-preview|computer-use|codex|deep-research|-pro\b/;
const TOO_SMALL_FOR_DOCUMENTS = /^gpt-3\.5|^gpt-4(-\d{4})?$|^gpt-4-32k/;
const UNSERVABLE_OFFSET = 900;

function isServableModel(canonicalName: string, plugin: string): boolean {
  return plugin !== "openai" || !(NOT_A_CHAT_MODEL.test(canonicalName) || TOO_SMALL_FOR_DOCUMENTS.test(canonicalName));
}

function servableModels(models: readonly string[], plugin: string): string[] {
  return models.filter((canonicalName) => isServableModel(canonicalName, plugin));
}

function selectedModelOf(
  models: { canonicalName: string; disabled: boolean }[],
): string | null {
  const enabled = models.filter((entry) => !entry.disabled);
  return enabled.length > 0 && enabled.length < models.length ? enabled[0]!.canonicalName : null;
}

function toListedProvider(
  row: HubModelProvider,
  credentialRows: HubCredential[],
  modelRows: HubModel[],
  offeringRows: HubOffering[],
  vendorRows: HubProvider[],
): ListedProvider {
  const credentialRow = credentialRows.find((entry) => entry.id === row.credentialId) ?? null;
  const vendorRow = vendorRows.find((entry) => entry.name === row.name) ?? null;
  const label = vendorRow?.metadata?.label;
  const models = offeringRows
    .filter((offering) => offering.providerId === row.id)
    .map((offering) => {
      const modelRow = modelRows.find((entry) => entry.id === offering.modelId);
      const canonicalName = modelRow?.canonicalName ?? "";
      return {
        canonicalName,
        priority: offering.priority,
        disabled: offering.disabled,
      };
    })
    .filter((entry) => isServableModel(entry.canonicalName, row.plugin))
    .sort((a, b) => a.priority - b.priority);
  const kind = credentialRow?.metadata?.keyless
    ? "local_endpoint"
    : credentialRow?.type === "oauth_token"
      ? "oauth"
      : "api_key";
  return {
    id: row.id,
    providerId: row.name,
    label: typeof label === "string" ? label : row.name,
    kind,
    baseUrl: row.baseURL || null,
    status: credentialRow?.status === "active" ? "ready" : (credentialRow?.status ?? "error"),
    statusDetail: null,
    models: models.map((entry) => entry.canonicalName),
    active: true,
    priority: models.length > 0 ? Math.floor(models[0]!.priority / 1000) : 0,
    hasCredential: kind !== "local_endpoint",
    validatedAt: credentialRow?.updatedAt ?? null,
    selectedModel: selectedModelOf(models),
  };
}

/** Connected providers in the workspace catalog, empty before a tenant exists. */
export async function listConnectedProviders(transport: Transport): Promise<ListedProvider[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  try {
    const catalog = catalogFor(transport, workspace.tenantId);
    const [providerRows, credentialRows, modelRows, offeringRows, vendorRows] = await Promise.all([
      catalog.modelProviders(),
      catalog.credentials(),
      catalog.models(),
      catalog.offerings(),
      catalog.providers(),
    ]);
    return providerRows
      .map((row) => toListedProvider(row, credentialRows, modelRows, offeringRows, vendorRows))
      .sort((a, b) => a.priority - b.priority);
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) return [];
    throw cause;
  }
}

/**
 * Disables offerings that cannot answer and puts the rest first, through
 * hub catalog patches. Same work the host used to expose as POST /catalog/rerank.
 */
export async function rerankCatalogViaHub(transport: Transport): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  const catalog = catalogFor(transport, workspace.tenantId);
  const [providerRows, modelRows, offeringRows] = await Promise.all([
    catalog.modelProviders(),
    catalog.models(),
    catalog.offerings(),
  ]);
  for (const row of providerRows) {
    const offerings = offeringRows
      .filter((offering) => offering.providerId === row.id)
      .sort((a, b) => a.priority - b.priority);
    const listed = offerings.map((offering) => modelRows.find((entry) => entry.id === offering.modelId)?.canonicalName ?? "");
    const serving = servableModels(listed, row.plugin);
    const basePriority = offerings.length > 0 ? Math.floor(offerings[0]!.priority / 1000) : 0;
    let behind = 0;
    for (const offering of offerings) {
      const canonicalName = modelRows.find((entry) => entry.id === offering.modelId)?.canonicalName ?? "";
      if (serving.includes(canonicalName)) continue;
      const priority = basePriority * 1000 + UNSERVABLE_OFFSET + behind;
      behind += 1;
      if (offering.disabled && offering.priority === priority) continue;
      await catalog.patchOffering(offering.id, { disabled: true, priority });
      offering.disabled = true;
      offering.priority = priority;
    }
    const served = offerings.filter((offering) =>
      serving.includes(modelRows.find((entry) => entry.id === offering.modelId)?.canonicalName ?? ""),
    );
    if (served.length > 0 && served.every((offering) => offering.disabled)) {
      for (const offering of served) {
        await catalog.patchOffering(offering.id, { disabled: false });
        offering.disabled = false;
      }
    }
    for (const [index, canonicalName] of serving.entries()) {
      const offering = offerings.find(
        (entry) => modelRows.find((model) => model.id === entry.modelId)?.canonicalName === canonicalName,
      );
      if (!offering) continue;
      const priority = basePriority * 1000 + index;
      if (offering.priority !== priority) {
        await catalog.patchOffering(offering.id, { priority });
        offering.priority = priority;
      }
    }
  }
}

// --- Connect, order, select, disconnect (API-key providers) ----------------

/** A candidate's known plugin and default base URL; `compatible` supplies its own. */
const PLUGIN_OF: Record<string, ModelProviderPlugin> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openai-compatible",
  xai: "openai-compatible",
  compatible: "openai-compatible",
};

const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * Lists the models a live key can actually serve, by asking the provider
 * itself -- the one validation available, since the hub has no route that
 * probes a third-party endpoint on the tenant's behalf. Throws with a message
 * fit to show directly: a bad key, an unreachable endpoint, or a key that
 * lists nothing this product can use are all reported as themselves rather
 * than swallowed into a generic failure.
 */
async function discoverModels(plugin: string, baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers:
        plugin === "anthropic"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${apiKey}` },
    });
  } catch (cause) {
    throw new Error(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`The provider rejected this key (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : "."}`);
  }
  const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const ids = (body?.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
  const serving = servableModels(ids, plugin);
  if (serving.length === 0) {
    throw new Error("This key works, but the provider did not list any model this product can use.");
  }
  return serving;
}

/**
 * Connects (or reconnects) an API-key provider on the workspace tenant: the
 * key is validated by listing the provider's own models before anything is
 * written, then the provider, credential and discovered offerings are
 * recorded through the hub's catalog routes. Returns the connected row as the
 * list already renders it.
 */
export async function connectApiKeyProvider(
  transport: Transport,
  input: { providerId: string; label: string; baseUrl?: string; apiKey: string },
): Promise<ListedProvider> {
  const plugin = PLUGIN_OF[input.providerId] ?? "openai-compatible";
  const baseURL = input.baseUrl?.trim() || DEFAULT_BASE_URL[input.providerId];
  if (!baseURL) {
    throw new Error(`${input.label} needs a base URL.`);
  }
  const canonicalNames = await discoverModels(plugin, baseURL, input.apiKey);

  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
    providerId: input.providerId,
    label: input.label,
    plugin,
    baseURL,
    apiKey: input.apiKey,
  });
  await registerProviderModels(transport, workspace.tenantId, { modelProviderId, canonicalNames });

  const connected = await listConnectedProviders(transport);
  const row = connected.find((entry) => entry.id === modelProviderId);
  if (!row) throw new Error("The provider connected, but did not come back in the catalog listing.");
  return row;
}

/** Disconnects a provider: removes it and its credential from the workspace catalog. */
export async function disconnectProvider(transport: Transport, modelProviderId: string): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await disconnectProviderViaHub(transport, workspace.tenantId, modelProviderId);
}

/** Reorders connected providers, most preferred first. */
export async function reorderProviders(transport: Transport, orderedModelProviderIds: readonly string[]): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await setProviderOrderViaHub(transport, workspace.tenantId, orderedModelProviderIds);
}

/** Pins a provider to one model, or clears the pin (`null`) so failover picks among all of them. */
export async function selectProviderModel(
  transport: Transport,
  modelProviderId: string,
  canonicalName: string | null,
): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await selectModelViaHub(transport, workspace.tenantId, modelProviderId, canonicalName);
}
