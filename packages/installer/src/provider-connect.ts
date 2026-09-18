/**
 * Connect, order, select and disconnect model providers on the workspace
 * tenant, entirely through the hub's own catalog routes (`provider`,
 * `credential`, `model_provider`, `model`, `model_offering`).
 *
 * Providers are defined once on the workspace tenant; a project inherits them
 * through tenant ancestry, never a per-project copy. Nothing here reaches a
 * database directly -- every write is a real hub route call over `Transport`,
 * the same contract `catalogFor` already builds on.
 *
 * Discovering which models a live key can actually serve requires calling the
 * provider's own API directly (the hub has no route that reaches out to a
 * third-party inference endpoint on the tenant's behalf), so that step is the
 * caller's job. This module only records what the caller already discovered.
 */
import { ApiError } from "@intx/hub-client";
import type { Transport } from "@intx/hub-client";
import { catalogFor, type HubCredential, type HubModelProvider, type HubProvider } from "./hub.js";

/** Mirrors `@intx/types`' `modelProviderPlugins`: the inference adapters the runtime dispatches to. */
export type ModelProviderPlugin = "anthropic" | "openai" | "openai-compatible" | "google-genai";

export type UpsertApiKeyProviderInput = {
  /** Vendor provider name, e.g. "anthropic" -- also the model-provider's own name. */
  providerId: string;
  label: string;
  plugin: ModelProviderPlugin;
  baseURL: string;
  apiKey: string;
};

export type UpsertApiKeyProviderResult = {
  vendorProviderId: string;
  credentialId: string;
  modelProviderId: string;
};

function credentialNameFor(providerId: string): string {
  return `provider:${providerId}`;
}

async function ensureVendorProvider(
  catalog: ReturnType<typeof catalogFor>,
  input: { providerId: string; label: string; plugin: string; baseURL: string },
): Promise<HubProvider> {
  const existing = (await catalog.providers()).find((row) => row.name === input.providerId);
  if (existing) return existing;
  return catalog.createProvider({
    name: input.providerId,
    plugin: input.plugin,
    apiBaseUrl: input.baseURL,
    metadata: { label: input.label },
  });
}

async function ensureApiKeyCredential(
  catalog: ReturnType<typeof catalogFor>,
  vendorProviderId: string,
  name: string,
  secret: string,
): Promise<HubCredential> {
  try {
    return await catalog.createCredential({ providerId: vendorProviderId, name, type: "api_key", secret });
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await catalog.resolveCredential(name);
    if (!existing) throw cause;
    return catalog.patchCredential(existing.id, { secret, status: "active" });
  }
}

async function ensureModelProvider(
  catalog: ReturnType<typeof catalogFor>,
  input: UpsertApiKeyProviderInput,
  credentialId: string,
): Promise<HubModelProvider> {
  const existing = (await catalog.modelProviders()).find((row) => row.name === input.providerId);
  if (existing) {
    if (existing.baseURL !== input.baseURL || existing.disabled) {
      return catalog.patchModelProvider(existing.id, { baseURL: input.baseURL, disabled: false });
    }
    return existing;
  }
  return catalog.createModelProvider({
    name: input.providerId,
    plugin: input.plugin,
    baseURL: input.baseURL,
    credentialId,
  });
}

/**
 * Connects (or reconnects) an API-key provider: the vendor `provider` row,
 * its sealed credential, and the model provider bound to it. Reconnecting
 * with a new key rotates the same credential row rather than minting a
 * second one -- a model provider's credential binding cannot be repointed
 * (only replaced by delete-and-recreate), so keeping the same credential id
 * is what makes a rotation, rather than a reconnect, land.
 */
export async function upsertApiKeyProvider(
  transport: Transport,
  scope: string,
  input: UpsertApiKeyProviderInput,
): Promise<UpsertApiKeyProviderResult> {
  const catalog = catalogFor(transport, scope);
  const vendorProvider = await ensureVendorProvider(catalog, input);
  const credential = await ensureApiKeyCredential(
    catalog,
    vendorProvider.id,
    credentialNameFor(input.providerId),
    input.apiKey,
  );
  const modelProvider = await ensureModelProvider(catalog, input, credential.id);
  return { vendorProviderId: vendorProvider.id, credentialId: credential.id, modelProviderId: modelProvider.id };
}

export type UpsertOAuthProviderInput = {
  /** Vendor provider name, e.g. "codex-oauth" -- also the credential's natural key. */
  providerId: string;
  label: string;
  /** The exchanged OAuth tokens, as `@corbits/oauth-core`'s `BaseTokens`. */
  tokens: { access: string; refresh: string; expiresAt?: number };
};

export type UpsertOAuthProviderResult = {
  vendorProviderId: string;
  credentialId: string;
};

async function ensureOAuthCredential(
  catalog: ReturnType<typeof catalogFor>,
  vendorProviderId: string,
  name: string,
  tokens: UpsertOAuthProviderInput["tokens"],
): Promise<HubCredential> {
  const fields = {
    type: "oauth_token" as const,
    secret: tokens.access,
    refreshSecret: tokens.refresh,
    ...(tokens.expiresAt !== undefined ? { expiresAt: new Date(tokens.expiresAt).toISOString() } : {}),
  };
  try {
    return await catalog.createCredential({ providerId: vendorProviderId, name, ...fields });
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await catalog.resolveCredential(name);
    if (!existing) throw cause;
    return catalog.patchCredential(existing.id, {
      secret: fields.secret,
      refreshSecret: fields.refreshSecret,
      status: "active",
      ...(tokens.expiresAt !== undefined ? { expiresAt: fields.expiresAt } : {}),
    });
  }
}

/**
 * Records a signed-in OAuth provider: the vendor `provider` row and its
 * sealed credential, holding the access/refresh token pair. Mirrors
 * `upsertApiKeyProvider`'s shape, minus the model provider/offering step --
 * an OAuth-connected provider's servable models are fixed by the adapter
 * (`@corbits/codex-provider`, `@corbits/xai-provider`), not discovered from a
 * live listing, so registering them is that adapter's own concern.
 */
export async function upsertOAuthProvider(
  transport: Transport,
  scope: string,
  input: UpsertOAuthProviderInput,
): Promise<UpsertOAuthProviderResult> {
  const catalog = catalogFor(transport, scope);
  const vendorProvider = await ensureVendorProvider(catalog, {
    providerId: input.providerId,
    label: input.label,
    plugin: "openai-compatible",
    baseURL: "",
  });
  const credential = await ensureOAuthCredential(catalog, vendorProvider.id, credentialNameFor(input.providerId), input.tokens);
  return { vendorProviderId: vendorProvider.id, credentialId: credential.id };
}

/**
 * Records exactly the models a live discovery found for a provider: a
 * tenant-local `model` row per canonical name (reusing one that already
 * exists), an offering pairing it to the provider, and every offering the
 * provider previously had that dropped out of this list disabled (never
 * deleted -- its price history and priority stay put if the model comes
 * back).
 */
export async function registerProviderModels(
  transport: Transport,
  scope: string,
  input: { modelProviderId: string; canonicalNames: readonly string[] },
): Promise<void> {
  const catalog = catalogFor(transport, scope);
  const [modelRows, offeringRows] = await Promise.all([catalog.models(), catalog.offerings()]);
  const existingOfferings = offeringRows.filter((row) => row.providerId === input.modelProviderId);
  const wanted = new Set(input.canonicalNames);

  for (const [index, canonicalName] of input.canonicalNames.entries()) {
    let modelRow = modelRows.find((row) => row.canonicalName === canonicalName);
    if (!modelRow) {
      modelRow = await catalog.createModel({ canonicalName });
      modelRows.push(modelRow);
    }
    const offering = existingOfferings.find((row) => row.modelId === modelRow!.id);
    if (!offering) {
      await catalog.createOffering({ modelId: modelRow.id, providerId: input.modelProviderId, priority: index });
    } else if (offering.disabled) {
      await catalog.patchOffering(offering.id, { disabled: false });
    }
  }

  for (const offering of existingOfferings) {
    const canonicalName = modelRows.find((row) => row.id === offering.modelId)?.canonicalName ?? "";
    if (!wanted.has(canonicalName) && !offering.disabled) {
      await catalog.patchOffering(offering.id, { disabled: true });
    }
  }
}

/**
 * Reorders providers by rewriting each of their offerings' priority into the
 * `basePriority * 1000 + withinProviderOffset` scheme the catalog already
 * reads a provider's rank from (there is no provider-level order column;
 * order lives entirely in offering priority). The within-provider offset --
 * which model answers first, and which fallbacks are pushed behind an
 * unservable one -- is preserved.
 */
export async function setProviderOrder(
  transport: Transport,
  scope: string,
  orderedModelProviderIds: readonly string[],
): Promise<void> {
  const catalog = catalogFor(transport, scope);
  const offeringRows = await catalog.offerings();
  for (const [index, modelProviderId] of orderedModelProviderIds.entries()) {
    for (const offering of offeringRows.filter((row) => row.providerId === modelProviderId)) {
      const withinProviderOffset = offering.priority % 1000;
      const priority = index * 1000 + withinProviderOffset;
      if (offering.priority !== priority) {
        await catalog.patchOffering(offering.id, { priority });
      }
    }
  }
}

/**
 * Pins a provider to exactly one model (disabling its other offerings), or
 * clears the pin (`canonicalName: null`, enabling every offering again) so
 * failover picks among all of them.
 */
export async function selectModel(
  transport: Transport,
  scope: string,
  modelProviderId: string,
  canonicalName: string | null,
): Promise<void> {
  const catalog = catalogFor(transport, scope);
  const [modelRows, offeringRows] = await Promise.all([catalog.models(), catalog.offerings()]);
  for (const offering of offeringRows.filter((row) => row.providerId === modelProviderId)) {
    const name = modelRows.find((row) => row.id === offering.modelId)?.canonicalName ?? "";
    const shouldEnable = canonicalName === null || name === canonicalName;
    if (offering.disabled === shouldEnable) {
      await catalog.patchOffering(offering.id, { disabled: !shouldEnable });
    }
  }
}

/**
 * Disconnects a provider: removes the model provider (the hub cascades its
 * offerings) and, best-effort, the credential it held. A credential still
 * referenced elsewhere (409) is left in place rather than failing the
 * disconnect.
 */
export async function disconnectProvider(transport: Transport, scope: string, modelProviderId: string): Promise<void> {
  const catalog = catalogFor(transport, scope);
  const providerRows = await catalog.modelProviders();
  const row = providerRows.find((entry) => entry.id === modelProviderId);
  await catalog.deleteModelProvider(modelProviderId);
  if (row?.credentialId) {
    try {
      await catalog.deleteCredential(row.credentialId);
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    }
  }
}
