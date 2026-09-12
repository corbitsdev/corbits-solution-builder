/**
 * Connected providers, as rows in Interchange's own model catalog.
 *
 * A connection in Settings becomes the platform's `provider`, `credential`,
 * `model_provider`, `model` and `model_offering` rows, written through the
 * hub's API as the workspace owner. Nothing here touches a table: the hub
 * validates, authorises and records each row the same way it would for any
 * other client.
 *
 * The API key is sealed into the credential row with Interchange's own
 * credential cipher (the encryption key lives in the OS keychain). The
 * sidecar decrypts that column and sends it as the bearer. A keychain
 * copy remains for host-side reads (refresh, disconnect); it is not what
 * the sidecar authenticates with.
 */
import { catalogModels, catalogProviders } from "@intx/inference-catalog";
import {
  catalog,
  workspaceOrNull,
  type HubCredential,
  type HubModel,
  type HubModelProvider,
  type HubOffering,
  type HubProvider,
} from "./hub-client.js";

export type Plugin = "anthropic" | "openai" | "openai-compatible" | "google-genai";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The capabilities and quirks a model offering carries, drawn from the
 * discovery support matrix baked into `@intx/inference-catalog`.
 *
 * A model the catalog does not know (a local endpoint's own model, an unlisted
 * relay) gets whatever the probe learned, and the OpenAI-compatible `/models`
 * listing this build probes carries nothing beyond an id. So nothing is
 * claimed: recording "plain-text" would be a guess dressed as a fact.
 */
export function catalogCapabilitiesFor(
  canonicalName: string,
  plugin: Plugin,
): { capabilities: string[]; quirks: Record<string, unknown> | null } {
  const candidates = catalogProviders.flatMap((provider) =>
    provider.offerings
      .filter((offering) => offering.model === canonicalName)
      .map((offering) => ({ plugin: provider.plugin, offering })),
  );
  const match = candidates.find((entry) => entry.plugin === plugin) ?? candidates[0];
  if (match) {
    return { capabilities: [...match.offering.capabilities], quirks: match.offering.quirks };
  }
  return { capabilities: [], quirks: null };
}

/**
 * Model ids that can never answer a chat completion, by family: embeddings,
 * speech, images, moderation, the completions-only legacy models, and the
 * models OpenAI serves only through its Responses endpoint. Only a
 * first-party OpenAI listing is read against this — it mixes every kind of
 * model into one `/models` reply — and a listing from any other endpoint is
 * taken as it comes, since its shape is unknown here.
 */
const NOT_A_CHAT_MODEL =
  /embedding|whisper|tts|transcribe|moderation|dall-e|sora|davinci|babbage|-instruct|realtime|audio|-image|search-preview|computer-use|codex|deep-research|-pro\b/;

/**
 * Chat models whose context cannot hold this product's documents. A stage's
 * prompt carries every approved artifact before it — a brief, the
 * constraints, the approach and a design run to some 25,000 tokens by
 * stage 5 — and a document is written under a 16,000-token output cap, so
 * a model needs room for both. The GPT-3.5 family (16k) and the original
 * GPT-4 (8k, 32k) do not have it: every call from stage 3 on would be
 * refused for length.
 */
const TOO_SMALL_FOR_DOCUMENTS = /^gpt-3\.5|^gpt-4(-\d{4})?$|^gpt-4-32k/;

/** Whether a listed model could serve the lifecycle's chat completions at all. */
export function isServableModel(canonicalName: string, plugin: Plugin): boolean {
  return plugin !== "openai" || !(NOT_A_CHAT_MODEL.test(canonicalName) || TOO_SMALL_FOR_DOCUMENTS.test(canonicalName));
}

/**
 * The models a provider is recorded as serving, in the order they are
 * preferred: the ones the inference catalog knows first, in the catalog's
 * own order, then the rest as the provider listed them. The lifecycle pins
 * whichever offering comes first, so the first one has to be a model that
 * can answer; a raw listing put an embeddings model there.
 */
export function servableModels(models: readonly string[], plugin: Plugin): string[] {
  const rank = (canonicalName: string) => {
    const index = catalogModels.findIndex((entry) => entry.canonicalName === canonicalName);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return models
    .filter((canonicalName) => isServableModel(canonicalName, plugin))
    .map((canonicalName, index) => ({ canonicalName, index, rank: rank(canonicalName) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.canonicalName);
}

export function catalogDisplayNameFor(canonicalName: string): string {
  return (
    catalogModels.find((entry) => entry.canonicalName === canonicalName)?.displayName ??
    canonicalName
  );
}

const KEYLESS_SECRET = "keyless:no-credential-required";

async function ensureProviderRow(
  providerId: string,
  label: string,
  baseUrl: string | undefined,
): Promise<HubProvider> {
  const existing = (await catalog.providers()).find((row) => row.name === providerId);
  if (existing) {
    const wants = { apiBaseUrl: baseUrl, metadata: { ...(existing.metadata ?? {}), label } };
    if (existing.apiBaseUrl !== (baseUrl ?? existing.apiBaseUrl) || existing.metadata?.label !== label) {
      return catalog.patchProvider(existing.id, {
        ...(baseUrl ? { apiBaseUrl: wants.apiBaseUrl! } : {}),
        metadata: wants.metadata,
      });
    }
    return existing;
  }
  return catalog.createProvider({
    name: providerId,
    plugin: providerId,
    ...(baseUrl ? { apiBaseUrl: baseUrl } : {}),
    metadata: { label },
  });
}

async function credentialFor(providerId: string): Promise<HubCredential | null> {
  const name = `provider:${providerId}`;
  return (await catalog.credentials()).find((row) => row.name === name) ?? null;
}

/**
 * Records a connection's credential. An API key is sealed into the row so
 * Interchange can deliver it to the sidecar as the bearer; a keychain
 * reference is kept in metadata for host-side reads. A keyless connection
 * (a local endpoint) gets the smallest honest stand-in the platform's
 * "exactly one credential per model provider" rule allows: a credential
 * typed `other`, holding no material, tagged keyless so every reader tells
 * it apart from a real one.
 */
export async function upsertCredential(input: {
  providerId: string;
  label: string;
  kind: "api_key" | "oauth" | "local_endpoint";
  credentialRef: string | null;
  /** The material Interchange seals. API keys pass the key; omit for OAuth. */
  secret?: string | null;
  baseUrl?: string;
  scopes?: string[];
}): Promise<HubCredential> {
  const provider = await ensureProviderRow(input.providerId, input.label, input.baseUrl);
  const keyless = input.kind === "local_endpoint" || !input.credentialRef;
  const sealed = keyless ? KEYLESS_SECRET : (input.secret ?? input.credentialRef!);
  const row = {
    type: keyless ? ("other" as const) : input.kind === "oauth" ? ("oauth_token" as const) : ("api_key" as const),
    secret: sealed,
    description: keyless
      ? "Placeholder for a keyless local endpoint — carries no secret material."
      : input.secret
        ? `${input.label}, sealed at rest. The encryption key lives in the OS keychain.`
        : `${input.label}, held in the OS keychain. This row carries the reference, never the secret.`,
    metadata: keyless ? { keyless: true } : { ref: input.credentialRef! },
    ...(input.scopes ? { scopes: input.scopes } : {}),
  };

  const existing = await credentialFor(input.providerId);
  if (existing) {
    // A (re)connection is validated before this is called, so it is active
    // again even if the previous key had gone stale.
    return catalog.patchCredential(existing.id, { ...row, status: "active" });
  }
  return catalog.createCredential({
    providerId: provider.id,
    name: `provider:${input.providerId}`,
    ...row,
  });
}

/** The keychain reference a provider authenticates with, or null when keyless. */
export async function getCredentialRef(providerId: string): Promise<string | null> {
  const row = await credentialFor(providerId);
  const ref = row?.metadata?.ref;
  return typeof ref === "string" ? ref : null;
}

/** Marks a credential validated again — after a successful models refresh. */
export async function touchCredentialValidated(providerId: string): Promise<void> {
  const row = await credentialFor(providerId);
  if (row) await catalog.patchCredential(row.id, { status: "active" });
}

/**
 * Records a connected provider and everything it can serve. Idempotent by
 * natural key: reconnecting updates rows rather than accumulating duplicates.
 */
export async function registerProviderCatalog(input: {
  providerId: string;
  label: string;
  plugin: Plugin;
  baseUrl: string;
  credentialId: string;
  models: readonly string[];
  priority?: number;
}): Promise<{ providerRowId: string; offerings: number }> {
  const name = slug(input.providerId);
  const modelProviders = await catalog.modelProviders();
  let providerRow = modelProviders.find((row) => row.name === name) ?? null;
  if (providerRow) {
    if (providerRow.baseURL !== input.baseUrl || providerRow.disabled) {
      providerRow = await catalog.patchModelProvider(providerRow.id, {
        baseURL: input.baseUrl,
        disabled: false,
      });
    }
  } else {
    providerRow = await catalog.createModelProvider({
      name,
      plugin: input.plugin,
      baseURL: input.baseUrl,
      credentialId: input.credentialId,
    });
  }

  const models = await catalog.models();
  const offerings = (await catalog.offerings()).filter(
    (row) => row.providerId === providerRow!.id,
  );

  const serving = servableModels(input.models, input.plugin);
  await retireUnservable(offerings, models, serving, input.priority ?? 0);
  await ensureOneServes(offerings, models, serving);

  let count = 0;
  for (const [index, canonicalName] of serving.entries()) {
    const modelRow =
      models.find((row) => row.canonicalName === canonicalName) ??
      (await catalog.createModel({ canonicalName, displayName: catalogDisplayNameFor(canonicalName) }));
    const { capabilities, quirks } = catalogCapabilitiesFor(canonicalName, input.plugin);
    // The operator's provider order decides which offering wins; within one
    // provider the order the models were discovered in is the tiebreak.
    const priority = (input.priority ?? 0) * 1000 + index;
    const existing = offerings.find((row) => row.modelId === modelRow.id);
    if (existing) {
      // Reconnecting must not silently re-enable an offering the operator
      // narrowed to a single selected model, so `disabled` is left alone.
      await catalog.patchOffering(existing.id, { priority, capabilities, quirks });
    } else {
      await catalog.createOffering({
        modelId: modelRow.id,
        providerId: providerRow.id,
        priority,
        capabilities,
        ...(quirks ? { quirks } : {}),
      });
    }
    count += 1;
  }

  return { providerRowId: providerRow.id, offerings: count };
}

/**
 * An offering this provider carries for a model it is no longer recorded as
 * serving — one a raw listing put there before the listing was read for
 * what can answer — is disabled and moved behind every served one. Not
 * deleted: a deployment may name it among its sources. Disabled, the
 * lifecycle never picks it, and `toProviderRow` keeps it out of the rows the
 * operator sees, so it never reads as a chosen model either.
 */
async function retireUnservable(
  offerings: HubOffering[],
  models: HubModel[],
  serving: readonly string[],
  basePriority: number,
): Promise<void> {
  let behind = 0;
  for (const offering of offerings) {
    const canonicalName = models.find((row) => row.id === offering.modelId)?.canonicalName ?? "";
    if (serving.includes(canonicalName)) continue;
    const priority = basePriority * 1000 + UNSERVABLE_OFFSET + behind;
    behind += 1;
    if (offering.disabled && offering.priority === priority) continue;
    await catalog.patchOffering(offering.id, { disabled: true, priority });
  }
}

/** Where a provider's retired offerings sit within its thousand: behind any it serves. */
const UNSERVABLE_OFFSET = 900;

/**
 * An operator's chosen model disables every other offering the provider
 * carries. When the chosen one is retired — it cannot answer, or the
 * provider no longer lists it — the provider would be left serving nothing
 * and the workspace would read as having no provider at all. The choice is
 * cleared instead: every served offering is enabled, and the host picks
 * among them as it does before a choice is made.
 */
async function ensureOneServes(offerings: HubOffering[], models: HubModel[], serving: readonly string[]): Promise<void> {
  const served = offerings.filter((offering) =>
    serving.includes(models.find((row) => row.id === offering.modelId)?.canonicalName ?? ""),
  );
  if (served.length === 0 || served.some((offering) => !offering.disabled)) return;
  for (const offering of served) await catalog.patchOffering(offering.id, { disabled: false });
}

/**
 * Reads every connected provider's models again for what can answer, and
 * reorders its offerings to match. Run on install so a workspace connected
 * before the listing was read this way is put right without a reconnect.
 */
export async function rerankCatalogProviders(): Promise<void> {
  if (!workspaceOrNull()) return;
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
    const serving = servableModels(listed, row.plugin as Plugin);
    const basePriority = offerings.length > 0 ? Math.floor(offerings[0]!.priority / 1000) : 0;
    await retireUnservable(offerings, modelRows, serving, basePriority);
    await ensureOneServes(offerings, modelRows, serving);
    for (const [index, canonicalName] of serving.entries()) {
      const offering = offerings.find((entry) => modelRows.find((model) => model.id === entry.modelId)?.canonicalName === canonicalName);
      if (!offering) continue;
      const priority = basePriority * 1000 + index;
      if (offering.priority !== priority) await catalog.patchOffering(offering.id, { priority });
    }
  }
}

export type CatalogModelRow = {
  offeringId: string;
  canonicalName: string;
  displayName: string;
  priority: number;
  capabilities: string[];
  disabled: boolean;
};

export type CatalogProviderRow = {
  providerRowId: string;
  providerId: string;
  label: string;
  plugin: Plugin;
  baseUrl: string;
  kind: "api_key" | "oauth" | "local";
  credentialId: string;
  /** From `credential.status`: "active" reads as ready, anything else as-is. */
  status: string;
  validatedAt: Date | null;
  /** Lowest first — the operator's order of preference. */
  basePriority: number;
  models: CatalogModelRow[];
};

/** Every connected provider in the workspace, unordered. Empty before install. */
export async function listCatalogProviders(): Promise<CatalogProviderRow[]> {
  if (!workspaceOrNull()) return [];

  const [providerRows, credentialRows, modelRows, offeringRows, vendorRows] = await Promise.all([
    catalog.modelProviders(),
    catalog.credentials(),
    catalog.models(),
    catalog.offerings(),
    catalog.providers(),
  ]);
  return providerRows.map((row) =>
    toProviderRow(row, credentialRows, modelRows, offeringRows, vendorRows),
  );
}

function toProviderRow(
  row: HubModelProvider,
  credentialRows: HubCredential[],
  modelRows: HubModel[],
  offeringRows: HubOffering[],
  vendorRows: HubProvider[],
): CatalogProviderRow {
  const credentialRow = credentialRows.find((entry) => entry.id === row.credentialId) ?? null;
  const vendorRow = vendorRows.find((entry) => entry.name === row.name) ?? null;
  const label = vendorRow?.metadata?.label;

  const models = offeringRows
    .filter((offering) => offering.providerId === row.id)
    .map((offering): CatalogModelRow => {
      const modelRow = modelRows.find((entry) => entry.id === offering.modelId);
      const canonicalName = modelRow?.canonicalName ?? "";
      return {
        offeringId: offering.id,
        canonicalName,
        displayName: modelRow?.displayName ?? canonicalName,
        priority: offering.priority,
        capabilities: offering.capabilities ?? [],
        disabled: offering.disabled,
      };
    })
    // A retired offering is not one the provider serves: out of the rows, so
    // it is neither offered as a choice nor read as one already made.
    .filter((entry) => isServableModel(entry.canonicalName, row.plugin as Plugin))
    .sort((a, b) => a.priority - b.priority);

  return {
    providerRowId: row.id,
    providerId: row.name,
    label: typeof label === "string" ? label : row.name,
    plugin: row.plugin as Plugin,
    baseUrl: row.baseURL ?? "",
    kind: credentialRow?.metadata?.keyless
      ? "local"
      : credentialRow?.type === "oauth_token"
        ? "oauth"
        : "api_key",
    credentialId: row.credentialId ?? "",
    status: credentialRow?.status === "active" ? "ready" : (credentialRow?.status ?? "error"),
    validatedAt: credentialRow?.updatedAt ? new Date(credentialRow.updatedAt) : null,
    basePriority: models.length > 0 ? Math.floor(models[0]!.priority / 1000) : 0,
    models,
  };
}

export async function getCatalogProvider(providerId: string): Promise<CatalogProviderRow | null> {
  const name = slug(providerId);
  return (await listCatalogProviders()).find((row) => row.providerId === name) ?? null;
}

/** Reorders a connected provider: every offering it carries moves to the new base. */
export async function setCatalogProviderPriority(
  providerId: string,
  basePriority: number,
): Promise<void> {
  const providerRow = await getCatalogProvider(providerId);
  if (!providerRow) return;
  const ordered = [...providerRow.models].sort((a, b) => a.priority - b.priority);
  for (const [index, entry] of ordered.entries()) {
    await catalog.patchOffering(entry.offeringId, { priority: basePriority * 1000 + index });
  }
}

/**
 * Records the operator's chosen model: every other offering this provider
 * carries is disabled. `null` clears the choice and re-enables every offering.
 */
export async function setCatalogSelectedModel(
  providerId: string,
  canonicalName: string | null,
): Promise<void> {
  const providerRow = await getCatalogProvider(providerId);
  if (!providerRow) return;
  for (const entry of providerRow.models) {
    const disabled = canonicalName !== null && entry.canonicalName !== canonicalName;
    if (disabled !== entry.disabled) await catalog.patchOffering(entry.offeringId, { disabled });
  }
}

/** Removes a connected provider's offerings, its adapter row, and its credential. */
export async function disconnectCatalogProvider(providerId: string): Promise<void> {
  const providerRow = await getCatalogProvider(providerId);
  if (!providerRow) return;
  for (const entry of providerRow.models) await catalog.deleteOffering(entry.offeringId);
  await catalog.deleteModelProvider(providerRow.providerRowId);
  if (providerRow.credentialId) await catalog.deleteCredential(providerRow.credentialId);
}
