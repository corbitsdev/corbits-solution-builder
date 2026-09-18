/**
 * Inference connections — read side.
 *
 * Connecting, reordering, selecting a model and disconnecting are now the
 * client's job: it talks to Interchange's own catalog (`provider`,
 * `credential`, `model_provider`, `model`, `model_offering`) directly over
 * `/hub`. This module keeps only what the host's own inference execution
 * (`inference.ts`, `deck-images.ts`) still needs to read: which providers are
 * connected, in what order, and how to get a bearer for one.
 */
import { listCatalogProviders, credentialSecretFor, type CatalogProviderRow, type CatalogModelRow } from "./catalog.js";
import { XAI_API_KEY_BASE_URL } from "@corbits/xai-provider";
import { accessTokenFor, OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth.js";

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

/** Known API-key providers, for the base URL a connected row's own is missing. */
const CATALOG: Record<string, { label: string; baseUrl: string }> = {
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  /**
   * xAI by API key. A different route to the same models as the OAuth
   * sign-in — different base URL, different entitlement — so the base comes
   * from the provider package rather than being restated here.
   */
  xai: { label: "xAI (API key)", baseUrl: XAI_API_KEY_BASE_URL },
  compatible: { label: "OpenAI-compatible endpoint", baseUrl: "" },
};

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
  return credentialSecretFor(provider.providerId);
}

export function catalogEntry(providerId: string) {
  return CATALOG[providerId];
}
