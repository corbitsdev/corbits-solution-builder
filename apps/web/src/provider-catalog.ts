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
  buildResolvedCatalogRows,
  catalogFor,
  disconnectProvider as disconnectProviderViaHub,
  makeResolvedModelDefault,
  moveResolvedModel as moveResolvedModelViaHub,
  registerProviderModels,
  resolveWorkspace,
  selectModel as selectModelViaHub,
  setProviderOrder as setProviderOrderViaHub,
  setResolvedModelRestricted as setResolvedModelRestrictedViaHub,
  setResolvedModelShadowed as setResolvedModelShadowedViaHub,
  stageSpecialistSourcePin,
  upsertApiKeyProvider,
  upsertOAuthProvider,
  type HubCredential,
  type HubModel,
  type HubModelProvider,
  type HubOffering,
  type HubProvider,
  type ModelMoveDirection,
  type ModelProviderPlugin,
  type ResolvedCatalogRow,
} from "@solutions-builder/installer";
import type { Stage } from "@solutions-builder/app/ledger";
import { CODEX_BASE_URL } from "@corbits/codex-provider";
import { XAI_DEFAULT_MODELS, XAI_OAUTH_PROXY_BASE_URL } from "@corbits/xai-provider";
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

export const API_KEY_CONNECT_OPTIONS: ReadonlyArray<{
  providerId: string;
  label: string;
  needsBaseUrl: boolean;
  /** The adapter the runtime dispatches this option to. */
  plugin: ModelProviderPlugin;
  /** The endpoint this option connects when the catalog seeds no row for it
   * (OpenRouter and custom endpoints are never seeded -- see `resolveConnectEndpoint`). */
  defaultBaseUrl?: string;
}> = [
  { providerId: "anthropic", label: "Anthropic", needsBaseUrl: false, plugin: "anthropic" },
  { providerId: "openai", label: "OpenAI", needsBaseUrl: false, plugin: "openai" },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    needsBaseUrl: false,
    plugin: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
  { providerId: "xai", label: "xAI (API key)", needsBaseUrl: false, plugin: "openai-compatible" },
  // Both Zen relays take the same Zen API key; each seeds its own vendor row
  // (see the installer's CONNECT_OVERLAY), so each is its own option.
  { providerId: "opencode-zen", label: "OpenCode Zen", needsBaseUrl: false, plugin: "openai-compatible" },
  { providerId: "opencode-zen-go", label: "OpenCode Zen Go", needsBaseUrl: false, plugin: "openai-compatible" },
  { providerId: "compatible", label: "OpenAI-compatible endpoint", needsBaseUrl: true, plugin: "openai-compatible" },
];

/** The one provider that needs no account and no key: a local OpenAI-compatible server. */
export const LOCAL_PROVIDER_ID = "local";
export const LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";

export const OAUTH_CONNECT_OPTIONS: ReadonlyArray<{ providerId: string; label: string; redirectUri: string }> = [
  { providerId: "codex-oauth", label: "ChatGPT (Codex)", redirectUri: "" },
  { providerId: "xai-oauth", label: "xAI (Grok)", redirectUri: "" },
];

/**
 * An OAuth adapter's fixed wire protocol, endpoint and servable models --
 * `@corbits/xai-provider` exports its own model list (`XAI_DEFAULT_MODELS`);
 * `@corbits/codex-provider` exports none, so this carries the current
 * Codex-servable model (`gpt-5.6-sol` — the `-wm` slug with the suffix
 * removed, the spelling the Responses endpoint accepts).
 */
const OAUTH_ADAPTER_OF: Record<string, { plugin: ModelProviderPlugin; baseURL: string; canonicalNames: readonly string[] }> = {
  "codex-oauth": { plugin: "openai-compatible", baseURL: CODEX_BASE_URL, canonicalNames: ["gpt-5.6-sol"] },
  "xai-oauth": { plugin: "openai-compatible", baseURL: XAI_OAUTH_PROXY_BASE_URL, canonicalNames: [...XAI_DEFAULT_MODELS] },
};

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

/**
 * The model a provider drafts with: the priority-first enabled offering.
 * Provider-list order never selects it, and a sibling-disable pin no longer
 * does either — a pin only *restricts* (the user's explicit choice via
 * `selectModel`), while the default always comes from priority. The pin
 * machinery itself is a legacy restriction mechanism slated for removal in
 * CL-8783; nothing here writes one. Null when nothing is enabled.
 */
function selectedModelOf(
  models: { canonicalName: string; priority: number; disabled: boolean }[],
): string | null {
  const enabled = models
    .filter((entry) => !entry.disabled)
    .sort((a, b) => a.priority - b.priority);
  return enabled[0]?.canonicalName ?? null;
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
    priority: models.length > 0 ? Math.floor(Math.min(...models.map((model) => model.priority)) / 1000) : 0,
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

/**
 * Where an API-key connect option dials, resolved in order: an explicit base
 * URL the caller passes, the workspace catalog's seeded vendor row (install
 * seeds plugin and base URL from the pinned catalog, so first-party providers
 * never hardcode an endpoint here), and finally the option's own default --
 * which only the never-seeded options (OpenRouter, custom endpoints) carry.
 * `seeded` reports whether the vendor row carries the install-time offering
 * snapshot the attach materializes; without one the connect falls back to
 * recording the live listing (the custom-endpoint exception).
 */
async function resolveConnectEndpoint(
  transport: Transport,
  workspaceTenantId: string,
  providerId: string,
  baseUrlOverride: string | undefined,
): Promise<{ plugin: ModelProviderPlugin; baseURL: string | undefined; seeded: boolean }> {
  const option = API_KEY_CONNECT_OPTIONS.find((entry) => entry.providerId === providerId);
  const vendors = await catalogFor(transport, workspaceTenantId).providers();
  const row = vendors.find((vendor) => vendor.name === providerId);
  const baseURL = baseUrlOverride?.trim() || row?.apiBaseUrl || option?.defaultBaseUrl;
  return {
    plugin: (row?.plugin ?? option?.plugin ?? "openai-compatible") as ModelProviderPlugin,
    baseURL,
    seeded: Array.isArray((row?.metadata ?? {})["offeringSpecs"]),
  };
}

// Anthropic's API rejects a browser-origin request outright (CORS) unless
// this opt-in header is present -- without it, every real key fails in
// `discoverModels` below with a network error before the response is ever
// read. Named as a constant so the literal header key appears once.
const ANTHROPIC_BROWSER_HEADER = "anthropic-" + "dangerous-direct-browser-access";

/** A provider's `/models` response rejecting the request outright, HTTP status attached so callers can tell an auth failure from anything else. */
export class ProviderRejectedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Lists the models a live key can actually serve, by asking the provider
 * itself -- the one validation available, since the hub has no route that
 * probes a third-party endpoint on the tenant's behalf. Throws with a message
 * fit to show directly: a bad key, an unreachable endpoint, or a key that
 * lists nothing this product can use are all reported as themselves rather
 * than swallowed into a generic failure.
 */
async function discoverModels(plugin: string, baseUrl: string, apiKey: string): Promise<string[]> {
  // Anthropic's base URL carries no version: its adapter appends `/v1/messages`.
  const url = `${baseUrl.replace(/\/+$/, "")}${plugin === "anthropic" ? "/v1" : ""}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers:
        plugin === "anthropic"
          ? {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              [ANTHROPIC_BROWSER_HEADER]: "true",
            }
          : apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : {},
    });
  } catch (cause) {
    throw new Error(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ProviderRejectedError(
      response.status,
      `The provider rejected this key (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : "."}`,
    );
  }
  const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const ids = (body?.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
  const serving = servableModels(ids, plugin);
  if (serving.length === 0) {
    throw new Error("This key works, but the provider did not list any model this product can use.");
  }
  return serving;
}

/** Whether a discovery failure means the credential is sealed (401/403) rather than something else (unreachable, bad response, ...). */
export function isSealedCredentialFailure(cause: unknown): boolean {
  return cause instanceof ProviderRejectedError && (cause.status === 401 || cause.status === 403);
}

/** Guards the destructive part of a refresh: an empty or partial discovery must never register or clear anything. */
export function requireDiscoveredModels(canonicalNames: readonly string[]): void {
  if (canonicalNames.length === 0) {
    throw new Error("The provider returned no models; nothing was changed.");
  }
}

/**
 * Connects (or reconnects) an API-key provider on the workspace tenant: the
 * key is validated by listing the provider's own models before anything is
 * written, then the provider and credential are recorded through the hub's
 * catalog routes. The listing is validation only -- it writes nothing. For a
 * seeded vendor the attach materializes the install-time offering snapshot
 * (restricted to the models the key actually serves); for a vendor with no
 * snapshot (OpenRouter, custom endpoints) the live listing is recorded
 * instead, the custom-endpoint exception. Returns the connected row as the
 * list already renders it.
 */
export async function connectApiKeyProvider(
  transport: Transport,
  input: { providerId: string; label: string; baseUrl?: string; apiKey: string },
): Promise<ListedProvider> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const endpoint = await resolveConnectEndpoint(transport, workspace.tenantId, input.providerId, input.baseUrl);
  if (!endpoint.baseURL) {
    throw new Error(`${input.label} needs a base URL.`);
  }
  const canonicalNames = await discoverModels(endpoint.plugin, endpoint.baseURL, input.apiKey);

  const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
    providerId: input.providerId,
    label: input.label,
    plugin: endpoint.plugin,
    baseURL: endpoint.baseURL,
    apiKey: input.apiKey,
    ...(endpoint.seeded ? { canonicalNames } : {}),
  });
  if (!endpoint.seeded) {
    await registerProviderModels(transport, workspace.tenantId, { modelProviderId, canonicalNames });
  }

  const connected = await listConnectedProviders(transport);
  const row = connected.find((entry) => entry.id === modelProviderId);
  if (!row) throw new Error("The provider connected, but did not come back in the catalog listing.");
  return row;
}

/**
 * Connects a local OpenAI-compatible server (Ollama and friends): the live
 * listing both validates reachability and supplies the offerings, since a
 * local endpoint has no seed snapshot -- the custom-endpoint exception to
 * attach-only connects. No key is required, and the credential is marked
 * keyless so the catalog renders it as a local endpoint
 * (`toListedProvider`'s `credentialRow?.metadata?.keyless` check).
 */
export async function connectLocalProvider(transport: Transport, input: { baseUrl?: string }): Promise<ListedProvider> {
  const baseURL = input.baseUrl?.trim() || LOCAL_DEFAULT_BASE_URL;
  const canonicalNames = await discoverModels("openai-compatible", baseURL, "");

  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
    providerId: LOCAL_PROVIDER_ID,
    label: "Ollama",
    plugin: "openai-compatible",
    baseURL,
    apiKey: "",
    keyless: true,
  });
  await registerProviderModels(transport, workspace.tenantId, { modelProviderId, canonicalNames });

  const connected = await listConnectedProviders(transport);
  const row = connected.find((entry) => entry.id === modelProviderId);
  if (!row) throw new Error("The provider connected, but did not come back in the catalog listing.");
  return row;
}

type OAuthLoginStatus =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; tokens: { access: string; refresh: string; expiresAt?: number } }
  | { status: "error"; message: string };

const OAUTH_POLL_INTERVAL_MS = 1_000;
const OAUTH_LOGIN_TIMEOUT_MS = 180_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a login started by `POST /api/oauth/:id/start` to land: polls the
 * mounted route's status until the loopback callback exchanges a code for
 * tokens, or the login errors or times out.
 */
async function waitForOAuthTokens(
  transport: Transport,
  providerId: string,
): Promise<{ access: string; refresh: string; expiresAt?: number }> {
  const deadline = Date.now() + OAUTH_LOGIN_TIMEOUT_MS;
  for (;;) {
    const state = await transport.fetch<OAuthLoginStatus>("GET", `/api/oauth/${providerId}/status`);
    if (state.status === "done") return state.tokens;
    if (state.status === "error") throw new Error(state.message);
    if (Date.now() >= deadline) throw new Error("Sign-in timed out. Try again.");
    await sleep(OAUTH_POLL_INTERVAL_MS);
  }
}

/**
 * Signs in to an OAuth provider (ChatGPT via Codex, xAI via Grok) through
 * the loopback flow the hub mounts on `@corbits/oauth-core`
 * (`packages/embed-hub/src/oauth-mount.ts`), then records the exchanged
 * tokens plus a model provider and offerings on the workspace tenant, so the
 * provider appears connected with selectable models right away. An
 * OAuth-connected provider has no discovered model listing -- its adapter's
 * servable models are fixed, not probed -- so the models registered are
 * `OAUTH_ADAPTER_OF`'s static list rather than anything this call fetches.
 *
 * `onAuthorizeUrl`, when given, is called with the URL the start call
 * returns, before the (potentially long) wait for the loopback callback --
 * so a caller can show it as a fallback if the browser did not open.
 */
export async function connectOAuthProvider(
  transport: Transport,
  input: { providerId: string; label: string },
  onAuthorizeUrl?: (url: string) => void,
): Promise<void> {
  const adapter = OAUTH_ADAPTER_OF[input.providerId];
  if (!adapter) throw new Error(`${input.label} has no registered inference adapter.`);
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const { authorizeUrl } = await transport.fetch<{ authorizeUrl: string }>("POST", `/api/oauth/${input.providerId}/start`);
  onAuthorizeUrl?.(authorizeUrl);
  const tokens = await waitForOAuthTokens(transport, input.providerId);
  await upsertOAuthProvider(transport, workspace.tenantId, {
    providerId: input.providerId,
    label: input.label,
    tokens,
    plugin: adapter.plugin,
    baseURL: adapter.baseURL,
    canonicalNames: adapter.canonicalNames,
  });
}

/** Disconnects a provider: removes it and its credential from the workspace catalog. */
export async function disconnectProvider(transport: Transport, modelProviderId: string): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await disconnectProviderViaHub(transport, workspace.tenantId, modelProviderId);
}

/** Reorders connected providers, most preferred first. User order only — the workspace default comes from offering priority (CL-8781). */
export async function reorderProviders(transport: Transport, orderedModelProviderIds: readonly string[]): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await setProviderOrderViaHub(transport, workspace.tenantId, orderedModelProviderIds);
}

/** Restricts a provider to one model, or clears the restriction (`null`) so specialists fail over across all of them in priority order. User choice only — the workspace default never writes here (CL-8781). */
export async function selectProviderModel(
  transport: Transport,
  modelProviderId: string,
  canonicalName: string | null,
): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await selectModelViaHub(transport, workspace.tenantId, modelProviderId, canonicalName);
}

export type ActiveModel = { canonicalName: string; providerLabel: string };

/**
 * One row of `GET /api/tenants/:id/models` — only the fields chat default
 * derivation reads. The route returns full `ModelInfo` rows; the rest
 * (pricing, capabilities, tags) is not this module's business.
 */
export type ResolvedModel = {
  canonicalName: string;
  offerings: { providerId: string; providerName: string; priority: number }[];
};

/**
 * The tenant's resolved catalog (CL-8781): every visible model with its
 * offerings in priority order, via `GET /api/tenants/:id/models` — the first
 * client usage of the discovery route. Chat default and failover derive from
 * this, never from provider-list order.
 */
export async function listWorkspaceResolvedModels(
  transport: Transport,
  workspaceTenantId: string,
): Promise<ResolvedModel[]> {
  return transport.fetch<ResolvedModel[]>("GET", `/api/tenants/${workspaceTenantId}/models`);
}

/**
 * The full `ModelInfo` row shape the Settings Inference panel reads: the
 * `ResolvedModel` subset above plus the identity, display, and capability
 * fields the resolved-catalog row builder merges with the raw tables.
 */
export type ResolvedCatalogEntry = {
  id: string;
  canonicalName: string;
  displayName: string | null;
  offerings: {
    offeringId: string;
    providerId: string;
    providerName: string;
    priority: number;
    capabilities: string[];
  }[];
};

export type { ModelMoveDirection, ResolvedCatalogRow } from "@solutions-builder/installer";

/**
 * The Settings Inference list (CL-8782): one row per model in fallback order
 * from `GET /api/tenants/:id/models`, merged with the raw catalog tables so
 * restricted rows stay visible and every row carries its PATCH targets.
 * Unseeded tenants (no workspace) and hub 4xx read as an explicit empty list
 * -- never simulated rows.
 */
export async function listResolvedCatalog(transport: Transport): Promise<ResolvedCatalogRow[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const catalog = catalogFor(transport, workspace.tenantId);
  try {
    const [resolved, models, offerings, modelProviders, credentials] = await Promise.all([
      transport.fetch<ResolvedCatalogEntry[]>("GET", `/api/tenants/${workspace.tenantId}/models`),
      catalog.models(),
      catalog.offerings(),
      catalog.modelProviders(),
      catalog.credentials(),
    ]);
    return buildResolvedCatalogRows({ resolved, models, offerings, modelProviders, credentials });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) return [];
    throw cause;
  }
}

/** Make a model the chat default (PATCH offerings priority, CL-8781 computation). */
export async function makeResolvedDefault(transport: Transport, targetModelId: string): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await makeResolvedModelDefault(transport, workspace.tenantId, targetModelId);
}

/** Move a visible model one step in fallback order (swaps head priorities). */
export async function moveResolvedModel(
  transport: Transport,
  targetModelId: string,
  direction: ModelMoveDirection,
): Promise<boolean> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return false;
  return moveResolvedModelViaHub(transport, workspace.tenantId, targetModelId, direction);
}

/** Restrict a model (disable offerings) or lift the restriction. */
export async function setResolvedRestricted(
  transport: Transport,
  targetModelId: string,
  restricted: boolean,
): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await setResolvedModelRestrictedViaHub(transport, workspace.tenantId, targetModelId, restricted);
}

/** Shadow (or unshadow) the providers serving a model (PATCH providers disabled-only). */
export async function setResolvedShadowed(
  transport: Transport,
  providerRowIds: readonly string[],
  shadowed: boolean,
): Promise<void> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return;
  await setResolvedModelShadowedViaHub(transport, workspace.tenantId, providerRowIds, shadowed);
}

/**
 * The workspace default model: the lowest-priority offering in the resolved
 * catalog (CL-8781) — the same pick `specialist-deploy.ts`'s
 * `ensureSpecialistDeploymentOnce` makes for a specialist that has never
 * deployed yet. Provider-list order never selects it; the resolved reader
 * already suppresses disabled offerings, so pins cannot either. This is only
 * a forecast of what the *next* deploy would use, not what an
 * already-deployed specialist is running — see `resolveActiveModel` below.
 */
async function resolveCatalogDefaultModel(transport: Transport, workspaceTenantId: string): Promise<ActiveModel | null> {
  const [resolved, providerRows, vendorRows] = await Promise.all([
    listWorkspaceResolvedModels(transport, workspaceTenantId),
    catalogFor(transport, workspaceTenantId).modelProviders(),
    catalogFor(transport, workspaceTenantId).providers(),
  ]);
  // The resolved list groups by model in discovery order, so the default is
  // the minimum across every offering — not the first model's first entry.
  let best: { canonicalName: string; providerId: string; providerName: string; priority: number } | null = null;
  for (const model of resolved) {
    for (const offering of model.offerings) {
      if (best === null || offering.priority < best.priority) {
        best = {
          canonicalName: model.canonicalName,
          providerId: offering.providerId,
          providerName: offering.providerName,
          priority: offering.priority,
        };
      }
    }
  }
  if (!best) return null;
  const provider = providerRows.find((row) => row.id === best.providerId);
  const vendorRow = provider ? vendorRows.find((row) => row.name === provider.name) : undefined;
  const label = vendorRow?.metadata?.label;
  return {
    canonicalName: best.canonicalName,
    providerLabel: typeof label === "string" ? label : best.providerName,
  };
}

/**
 * The model specialists are actually drafting with, right now.
 *
 * An already-deployed specialist keeps whatever offering it was deployed
 * against -- `ensureSpecialistDeploymentOnce` hands back a live deployment
 * unchanged (`specialist-deploy.ts`), it never rebinds one to a provider
 * connected or reordered afterward. So once `projectId`/`stage` name a
 * project and stage whose specialist may already be deployed, this reads
 * that deployment's own pinned `(provider, model)` back off its asset tree
 * (`stageSpecialistSourcePin`) instead of recomputing from the tenant's
 * current catalog default (the lowest-priority offering), which can have
 * moved on since. Falls back to the
 * catalog default -- what the *next* deploy would pin -- when no specialist
 * is deployed yet for that stage, or when `projectId`/`stage` are omitted
 * (the workspace-wide callers that predate a stage context).
 */
export async function resolveActiveModel(
  transport: Transport,
  projectId?: string,
  stage?: Stage,
): Promise<ActiveModel | null> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return null;

  if (projectId !== undefined && stage !== undefined) {
    const pin = await stageSpecialistSourcePin(transport, workspace.tenantId, projectId, stage);
    if (pin) {
      const providerRows = await catalogFor(transport, workspace.tenantId).providers();
      const provider = providerRows.find((row) => row.plugin === pin.provider);
      const label = provider?.metadata?.label;
      return {
        canonicalName: pin.model,
        providerLabel: typeof label === "string" ? label : (provider?.name ?? pin.provider),
      };
    }
  }

  return resolveCatalogDefaultModel(transport, workspace.tenantId);
}

/** A pinned model the fresh discovery no longer serves -- `null` when nothing needs clearing. */
export function droppedSelection(selected: string | null, discovered: readonly string[]): string | null {
  if (selected === null) return null;
  return discovered.includes(selected) ? null : selected;
}

/**
 * Re-runs the same discovery `connectApiKeyProvider` does at connect time,
 * for a provider that is already connected -- no credential is asked for
 * again, since the hub never hands a sealed secret back to the client. If the
 * pinned model dropped out of the fresh list, its pin is cleared so failover
 * picks among what is actually served.
 */
export async function refreshProviderModels(
  transport: Transport,
  modelProviderId: string,
): Promise<{ clearedModel: string | null }> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  const catalog = catalogFor(transport, workspace.tenantId);
  const providerRows = await catalog.modelProviders();
  const row = providerRows.find((entry) => entry.id === modelProviderId);
  if (!row) throw new Error("This provider is no longer connected.");

  const connected = await listConnectedProviders(transport);
  const selected = connected.find((entry) => entry.id === modelProviderId)?.selectedModel ?? null;

  let canonicalNames: string[];
  try {
    canonicalNames = await discoverModels(row.plugin, row.baseURL, "");
  } catch (cause) {
    if (isSealedCredentialFailure(cause)) {
      throw new Error("This provider's key is sealed in the hub, so its model list can only be refreshed by reconnecting it.");
    }
    throw cause;
  }
  requireDiscoveredModels(canonicalNames);

  await registerProviderModels(transport, workspace.tenantId, { modelProviderId, canonicalNames });

  const clearedModel = droppedSelection(selected, canonicalNames);
  if (clearedModel) await selectModelViaHub(transport, workspace.tenantId, modelProviderId, null);
  return { clearedModel };
}
