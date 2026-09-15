/**
 * Inference connections — BUILD_PLAN_V3 section 5, PRD section 6.
 *
 * Three connection methods: API key, local endpoint (any OpenAI-compatible server),
 * and OAuth. The host owns credentials; nothing here returns a secret, and no
 * response body carries one.
 *
 * The rule this module exists to keep: when a local endpoint is unavailable,
 * the state is *unavailable*, with a reconnect action. There is no cloud
 * failover, silent or otherwise.
 *
 * Interchange's own catalog (`provider`, `credential`, `model_provider`,
 * `model`, `model_offering`) is the only store for a connected provider — this
 * module never touches those tables directly, only through `catalog.ts`.
 * A local endpoint has no account and no key, so `model_provider`'s
 * requirement of exactly one of `credentialId`/`walletId` is met by a
 * placeholder `credential` row `catalog.ts` mints and tags
 * `{ keyless: true }` — never a real secret, and never read as one:
 * `ProviderSummary.hasCredential` is derived from that tag, not from the
 * row's mere existence.
 */
import { HostError, notFound } from "./errors.js";
import { forgetAllExecutions } from "./hub-executor.js";
import { storeSecret, deleteSecret, readSecret } from "./provider-credentials.js";
import {
  registerProviderCatalog,
  listCatalogProviders,
  getCatalogProvider,
  getCredentialRef,
  touchCredentialValidated,
  setCatalogProviderPriority,
  setCatalogSelectedModel,
  disconnectCatalogProvider,
  type Plugin,
  type CatalogProviderRow,
  type CatalogModelRow,
  upsertCredential,
} from "./catalog.js";
import { XAI_API_KEY_BASE_URL } from "@corbits/xai-provider";
import {
  DEFINITIONS,
  OAUTH_PROVIDERS,
  accessTokenFor,
  beginLogin,
  completeLogin,
  logout as oauthLogout,
  openBrowser,
  refreshModels,
  type OAuthProviderId,
} from "./oauth.js";
import type { ProviderConnectRequest } from "./domain.js";

export type ProviderCapabilities = {
  text: boolean;
  tools: boolean;
  streaming: boolean;
  /** Unknown is unknown. It is never rendered as "supported". */
  structuredOutput: "supported" | "unsupported" | "unknown";
};

export type ProviderSummary = {
  id: string;
  providerId: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  status: string;
  statusDetail: string | null;
  models: string[];
  capabilities: ProviderCapabilities;
  active: boolean;
  /** Preference order, lowest first. */
  priority: number;
  validatedAt: Date | null;
  /** The operator's chosen model, or null to let the host pick. */
  selectedModel: string | null;
  /** Present so the UI can say "connected" without ever seeing the secret. */
  hasCredential: boolean;
};

/** Known API-key providers. OAuth lives in `oauth.ts`, on the corbitsdev stack. */
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
  /**
   * xAI by API key. A different route to the same models as the OAuth
   * sign-in — different base URL, different entitlement — so the base comes
   * from the provider package rather than being restated here. The two are not
   * interchangeable and are not presented as one connection.
   */
  xai: {
    label: "xAI (API key)",
    baseUrl: XAI_API_KEY_BASE_URL,
    probe: "/models",
    header: (key: string) => ({ authorization: `Bearer ${key}` }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
  /**
   * Any other OpenAI-compatible endpoint, with the base URL supplied by the
   * operator. This is the seam the rest of the ecosystem arrives through:
   * `corbits-router` as a gateway, `subcritical`'s Apple Foundation Models
   * bridge on loopback, LM Studio, vLLM. None of them needs its own adapter —
   * they speak a protocol this already speaks.
   */
  compatible: {
    label: "OpenAI-compatible endpoint",
    baseUrl: "",
    probe: "/models",
    header: (key: string) => ({ authorization: `Bearer ${key}` }),
    models: (body: { data?: { id: string }[] }) => (body.data ?? []).map((row) => row.id),
  },
} as const;

/**
 * OAuth sign-in options, from the corbitsdev provider packages. These are real
 * issuer configurations, not placeholders — the client ids, endpoints and
 * loopback redirects come from `@corbits/codex-provider` and
 * `@corbits/xai-provider`.
 */
export const OAUTH_CANDIDATES = OAUTH_PROVIDERS.map((providerId) => ({
  providerId,
  label: DEFINITIONS[providerId].label,
  redirectUri: DEFINITIONS[providerId].redirectUri,
}));

/**
 * Which Interchange inference adapter serves each provider we can connect.
 * Anything OpenAI-shaped that is not OpenAI itself is `openai-compatible`.
 */
const PLUGINS: Record<string, Plugin> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openai-compatible",
  xai: "openai-compatible",
  compatible: "openai-compatible",
  "codex-oauth": "openai-compatible",
  "xai-oauth": "openai-compatible",
  local: "openai-compatible",
};

/** The local endpoint's own single connection slot, whatever is serving it. */
const LOCAL_PROVIDER_ID = "local";

function summarizeCapabilities(models: CatalogModelRow[]): ProviderCapabilities {
  const all = new Set(models.flatMap((entry) => entry.capabilities));
  return {
    text: all.has("plain-text"),
    tools: all.has("function-calling"),
    streaming: all.has("plain-text-streaming"),
    structuredOutput: all.has("structured-output") ? "supported" : "unknown",
  };
}

function selectedModelOf(models: CatalogModelRow[]): string | null {
  const enabled = models.filter((entry) => !entry.disabled);
  return enabled.length > 0 && enabled.length < models.length ? enabled[0]!.canonicalName : null;
}

function catalogToSummary(row: CatalogProviderRow): ProviderSummary {
  return {
    id: row.providerRowId,
    providerId: row.providerId,
    label: row.label,
    kind: row.kind === "local" ? "local_endpoint" : row.kind,
    baseUrl: row.baseUrl || null,
    status: row.status,
    statusDetail: null,
    models: row.models.map((entry) => entry.canonicalName),
    capabilities: summarizeCapabilities(row.models),
    active: true,
    priority: row.basePriority,
    validatedAt: row.validatedAt,
    selectedModel: selectedModelOf(row.models),
    hasCredential: row.kind !== "local",
  };
}

/**
 * Records which model the active provider should use.
 *
 * Model choice is the operator's, not a guess: on a local endpoint the
 * difference between a fast instruct model and a slow reasoning one is the
 * difference between a stage that drafts in a minute and one that appears to
 * hang. The host defaults sensibly and says what it chose.
 */
/** Records the operator's chosen model for a provider; null clears the choice, and the host picks again. */
export async function selectModel(providerId: string, model: string | null): Promise<ProviderSummary> {
  const catalogRow = await getCatalogProvider(providerId);
  if (!catalogRow) throw notFound("That provider connection");
  if (model !== null && !catalogRow.models.some((entry) => entry.canonicalName === model)) {
    throw new HostError(
      "validation_failed",
      `${model} is not in that provider's validated catalogue.`,
    );
  }
  await setCatalogSelectedModel(providerId, model);
  catalogChanged();
  return catalogToSummary((await getCatalogProvider(providerId))!);
}

/**
 * What the catalog serves decides the model every lifecycle is pinned to,
 * so after any change to it each project's deployment is resolved again on
 * its next command. Without this a model chosen in Settings took effect
 * only after the host restarted.
 */
function catalogChanged(): void {
  forgetAllExecutions();
}

export async function listProviders(): Promise<ProviderSummary[]> {
  const catalogRows = await listCatalogProviders();
  return catalogRows.map(catalogToSummary).sort((a, b) => a.priority - b.priority);
}

/**
 * Providers to try, in the operator's order.
 *
 * More than one can be connected, and the order is theirs to set. This is not
 * a hidden failover: the host only moves down the list when the one above it
 * refuses the request, and it reports which provider actually answered, so a
 * switch is visible in the artifact's provenance rather than silent.
 */
export async function providerOrder(): Promise<ProviderSummary[]> {
  const providers = await listProviders();
  return providers.filter((provider) => provider.status === "ready");
}

/** Reorders the connected providers. The list is the new order, first to last. */
export async function setProviderOrder(providerIds: string[]): Promise<ProviderSummary[]> {
  for (const [index, providerId] of providerIds.entries()) {
    await setCatalogProviderPriority(providerId, index);
  }
  catalogChanged();
  return listProviders();
}

/**
 * Addresses worth offering when someone connects a local endpoint. Any server
 * speaking the OpenAI-compatible surface belongs here; these are starting
 * points, not a supported list, and the field takes anything.
 *
 * The first is the default the form opens on only because it is the most
 * common, not because the product is built around it.
 */
export const LOCAL_ENDPOINT_SUGGESTIONS: ReadonlyArray<{ label: string; baseUrl: string }> = [
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { label: "vLLM", baseUrl: "http://localhost:8000/v1" },
  { label: "llama.cpp", baseUrl: "http://localhost:8080/v1" },
];

/** What the connect form opens on. One of the suggestions, not a hardcoded product assumption. */
export const DEFAULT_LOCAL_BASE_URL = LOCAL_ENDPOINT_SUGGESTIONS[0]!.baseUrl;

/** Probes a local OpenAI-compatible endpoint, whichever server is behind it. */
/**
 * Probes a local endpoint and returns the models it serves **and the base URL
 * that actually answered**.
 *
 * Returning the base is the point. A person reasonably types either
 * `http://localhost:11434` or `.../v1`, and this tolerates both — but it used
 * to normalize only for its own probe and throw that away, so the bare form
 * was stored and every later inference call asked for `/chat/completions`
 * against a root that only serves `/v1/chat/completions`. The endpoint
 * connected, reported ready, listed its models, and then refused every
 * request with a 404. What is stored is now the base that was proven to work.
 */
export function localEndpointBase(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : new URL("/v1", root).toString().replace(/\/+$/, "");
}

/**
 * How long the probe waits. Generous enough for an endpoint that is reachable
 * but not local -- a Tailscale host, a LAN box, a server still loading a model -- and
 * short enough that a genuinely absent service is reported promptly.
 */
const PROBE_TIMEOUT_MS = 10_000;

async function validateLocalEndpoint(baseUrl: string): Promise<{ models: string[]; baseUrl: string }> {
  const base = localEndpointBase(baseUrl);
  const target = `${base}/models`;
  // The reason the probe failed is the only useful thing here, and discarding
  // it left one sentence for every cause: a service that is not running, a
  // name that does not resolve, a TLS refusal, a reachable-but-slow endpoint
  // that exceeded the timeout. The old text also named one vendor's binary,
  // which is wrong advice for most causes and for every other server that
  // speaks this API -- so it says what failed, not what to run.
  let response: Response;
  try {
    response = await fetch(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new HostError(
      "provider_unavailable",
      timedOut
        ? `${base} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds. It may be starting up, or too far away to answer that quickly.`
        : `Nothing answered at ${base}: ${cause instanceof Error ? cause.message : String(cause)}. Check the endpoint is serving and the address is reachable from here.`,
      {},
      true,
    );
  }
  if (!response.ok) {
    throw new HostError(
      "provider_unavailable",
      `The local endpoint answered ${response.status}. Check that the service is running.`,
      {},
      true,
    );
  }
  const body = (await response.json()) as { data?: { id: string }[] };
  const models = (body.data ?? []).map((row) => row.id);
  if (models.length === 0) {
    throw new HostError(
      "provider_unavailable",
      "That endpoint is running but serves no models. Load or download one in whatever is serving it, then connect again.",
      {},
      true,
    );
  }
  return { models, baseUrl: base };
}

async function validateApiKey(
  providerId: keyof typeof CATALOG,
  secret: string,
  baseUrlOverride?: string,
) {
  const entry = CATALOG[providerId];
  const base = baseUrlOverride?.replace(/\/+$/, "") || entry.baseUrl;
  if (!base) {
    throw new HostError("validation_failed", "That provider needs a base URL.");
  }
  const response = await fetch(`${base}${entry.probe}`, {
    headers: entry.header(secret),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    // The provider says why — wrong key, expired, no credit, wrong account —
    // and "rejected" alone sends somebody to re-copy a key that was fine.
    const said = await response
      .text()
      .then((body) => {
        const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
        return parsed.error?.message ?? parsed.message ?? "";
      })
      .catch(() => "");
    throw new HostError(
      "not_authorized",
      said
        ? `${entry.label} rejected that key: ${said}`
        : `${entry.label} rejected that key, and said nothing about why.`,
    );
  }
  if (!response.ok) {
    throw new HostError(
      "provider_unavailable",
      `${entry.label} answered ${response.status}.`,
      {},
      true,
    );
  }
  return entry.models((await response.json()) as { data?: { id: string }[] });
}

/**
 * Connects a provider and validates it before recording it as ready.
 *
 * An API-key secret is validated, stored in the keychain for host-side
 * reads, and sealed into Interchange's credential row so the sidecar can
 * present it as the bearer. Plaintext never lands in a log or a response.
 */
export async function connectProvider(
  request: ProviderConnectRequest,
): Promise<ProviderSummary> {
  if (request.kind === "oauth") {
    throw new HostError(
      "validation_failed",
      "OAuth connects through the sign-in flow, not this endpoint. Start it from Settings.",
    );
  }

  if (request.kind === "local_endpoint") {
    if (!request.baseUrl) {
      throw new HostError("validation_failed", "A local endpoint needs a base URL.");
    }
    // The base that answered, not the one that was typed: what is stored has
    // to be what later inference calls are built against.
    const { models, baseUrl: validatedBaseUrl } = await validateLocalEndpoint(request.baseUrl);
    const existing = await getCatalogProvider(LOCAL_PROVIDER_ID);
    const priorSelected = existing ? selectedModelOf(existing.models) : null;
    const priority = existing ? existing.basePriority : (await listProviders()).length;

    const link = await upsertCredential({
      providerId: LOCAL_PROVIDER_ID,
      label: request.label,
      kind: "local_endpoint",
      credentialRef: null,
      baseUrl: validatedBaseUrl,
    });
    catalogChanged();
  await registerProviderCatalog({
      providerId: LOCAL_PROVIDER_ID,
      label: request.label,
      plugin: PLUGINS[LOCAL_PROVIDER_ID] ?? "openai-compatible",
      baseUrl: validatedBaseUrl,
      credentialId: link.id,
      models,
      priority,
    });
    await touchCredentialValidated(LOCAL_PROVIDER_ID);
    if (priorSelected && !models.includes(priorSelected)) {
      await setCatalogSelectedModel(LOCAL_PROVIDER_ID, null);
    }
    return catalogToSummary((await getCatalogProvider(LOCAL_PROVIDER_ID))!);
  }

  // A pasted key routinely carries a trailing newline or a stray space, and
  // the provider rejects it with the same 401 an invalid key gets — so the
  // person is told their key is wrong when it is fine. Trim before anything
  // sees it, including the keychain.
  if (typeof request.secret === "string") request = { ...request, secret: request.secret.trim() };

  if (!request.secret) {
    throw new HostError("validation_failed", "An API key connection needs a key.");
  }
  if (!(request.providerId in CATALOG)) {
    throw new HostError("validation_failed", `Unsupported provider: ${request.providerId}.`);
  }
  const providerId = request.providerId as keyof typeof CATALOG;
  const models = await validateApiKey(providerId, request.secret, request.baseUrl);
  const baseUrl = request.baseUrl?.replace(/\/+$/, "") || CATALOG[providerId].baseUrl;
  const credentialRef = await storeSecret(`provider:${request.providerId}`, request.secret);

  // §5: the hub learns the connection exists, and the catalog the
  // credential authenticates. Without these rows there is nothing for a
  // workflow definition to resolve a canonical model name against — the
  // connection would be a secret the host holds privately rather than a
  // capability the platform can deploy. There is no host-side fallback left
  // for either write failing, so a failure here must not read as success: the
  // secret is dropped and the caller is told to try again.
  const priority = (await listProviders()).length;
  try {
    const link = await upsertCredential({
      providerId: request.providerId,
      label: request.label,
      kind: request.kind,
      credentialRef,
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
    // Roll the platform back too, not just the keychain. Dropping the secret
    // alone left a `credential` row pointing at an entry that no longer
    // exists — a connection that reads as present and cannot authenticate,
    // until some later reconnect happens to overwrite it.
    await disconnectCatalogProvider(request.providerId).catch(() => {});
    await deleteSecret(credentialRef).catch(() => {});
    throw new HostError(
      "provider_unavailable",
      `${request.label} validated, but could not be recorded: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      {},
      true,
    );
  }

  return catalogToSummary((await getCatalogProvider(request.providerId))!);
}

/**
 * Starts a browser sign-in and returns the authorize URL. The binding is not
 * written until the callback completes: a cancelled or failed login leaves no
 * half-connected provider behind.
 */
export async function startOAuthConnect(providerId: string): Promise<{
  authorizeUrl: string;
  browserOpened: boolean;
  detail: string;
}> {
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(providerId)) {
    throw new HostError("validation_failed", `Unknown OAuth provider: ${providerId}.`);
  }
  const started = await beginLogin(providerId as OAuthProviderId);
  const browser = openBrowser(started.authorizeUrl);
  return {
    authorizeUrl: started.authorizeUrl,
    browserOpened: browser.opened,
    detail: browser.detail,
  };
}

/** Waits for the callback and records the connected provider. */
export async function finishOAuthConnect(): Promise<ProviderSummary> {
  const completed = await completeLogin();
  const definition = DEFINITIONS[completed.providerId];
  const priority = (await listProviders()).length;

  try {
    const link = await upsertCredential({
      providerId: completed.providerId,
      label: definition.label,
      kind: "oauth",
      credentialRef: completed.credentialRef,
      baseUrl: completed.baseUrl,
    });
    if (!link) throw new Error("the hub did not return a credential reference");
    catalogChanged();
  await registerProviderCatalog({
      providerId: completed.providerId,
      label: definition.label,
      plugin: PLUGINS[completed.providerId] ?? "openai-compatible",
      baseUrl: completed.baseUrl,
      credentialId: link.id,
      models: completed.models,
      priority,
    });
  } catch (cause) {
    await oauthLogout(completed.providerId as OAuthProviderId).catch(() => {});
    throw new HostError(
      "provider_unavailable",
      `Signed in, but could not be recorded: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      {},
      true,
    );
  }

  return catalogToSummary((await getCatalogProvider(completed.providerId))!);
}

/**
 * Re-asks a connected provider what it serves. Model families move fast, so the
 * catalogue is refreshable without disconnecting and signing in again.
 */
export async function refreshProviderModels(providerId: string): Promise<ProviderSummary> {
  const catalogRow = await getCatalogProvider(providerId);
  if (!catalogRow) throw notFound("That provider connection");

  const isLocal = providerId === LOCAL_PROVIDER_ID;
  const models = isLocal
    ? (await validateLocalEndpoint(catalogRow.baseUrl)).models
    : (OAUTH_PROVIDERS as readonly string[]).includes(providerId)
      ? await refreshModels(providerId as OAuthProviderId)
      : await validateApiKey(
          providerId as keyof typeof CATALOG,
          (await readSecret((await getCredentialRef(providerId)) ?? "")) ?? "",
          catalogRow.baseUrl || undefined,
        );

  // A model the operator had selected that the provider no longer serves is
  // cleared rather than left pointing at nothing.
  const priorSelected = selectedModelOf(catalogRow.models);

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
  if (priorSelected && !models.includes(priorSelected)) {
    await setCatalogSelectedModel(providerId, null);
  }
  return catalogToSummary((await getCatalogProvider(providerId))!);
}

export async function disconnectProvider(providerId: string): Promise<void> {
  const catalogRow = await getCatalogProvider(providerId);
  if (!catalogRow) throw notFound("That provider connection");

  if ((OAUTH_PROVIDERS as readonly string[]).includes(providerId)) {
    await oauthLogout(providerId as OAuthProviderId);
  } else if (providerId !== LOCAL_PROVIDER_ID) {
    const ref = await getCredentialRef(providerId);
    if (ref) await deleteSecret(ref);
  }
  await disconnectCatalogProvider(providerId);
  catalogChanged();
}

/**
 * Resolves the bearer token for a call. The only reader; never crosses the API.
 * An OAuth provider goes through the token session, so an expired access token
 * is refreshed here rather than failing the request.
 */
export async function credentialFor(provider: ProviderSummary): Promise<string | null> {
  if ((OAUTH_PROVIDERS as readonly string[]).includes(provider.providerId)) {
    const tokens = await accessTokenFor(provider.providerId as OAuthProviderId);
    return tokens.access;
  }
  if (!provider.hasCredential) return null;
  const ref = await getCredentialRef(provider.providerId);
  return ref ? readSecret(ref) : null;
}

export function catalogEntry(providerId: string) {
  return CATALOG[providerId as keyof typeof CATALOG];
}

export const API_KEY_PROVIDERS = Object.entries(CATALOG).map(([providerId, entry]) => ({
  providerId,
  label: entry.label,
  /** True when the operator must supply the base URL themselves. */
  needsBaseUrl: entry.baseUrl === "",
}));
