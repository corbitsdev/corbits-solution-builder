/**
 * Connected inference, read and reranked through the hub catalog.
 *
 * The host still owns connect, OAuth loopback, refresh and disconnect. The
 * product list is the catalog the hub already stores, so the client lists
 * and reranks over `/hub` instead of asking the host's provider domain.
 */
import {
  ApiError,
  catalogFor,
  resolveWorkspace,
  type HubCredential,
  type HubModel,
  type HubModelProvider,
  type HubOffering,
  type HubProvider,
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
