/**
 * Connected providers, as rows in Interchange's own model catalog — read
 * side only. Connecting, reordering, choosing a model and disconnecting
 * (including an OAuth sign-in's own credential) are the client's job now
 * (`packages/installer/src/provider-connect.ts` and
 * `apps/web/src/provider-catalog.ts`, over `/hub`'s own catalog routes); the
 * host mutated these rows directly before PR #313 deleted that path, and
 * host-side inference that used to read a connected secret back is gone too.
 * The secret — an API key, or a signed-in OAuth token pair — is sealed into
 * the credential row with Interchange's own credential cipher; nothing here
 * decrypts it.
 */
import { catalogModels } from "@intx/inference-catalog";
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
): Promise<number> {
  let behind = 0;
  let changed = 0;
  for (const offering of offerings) {
    const canonicalName = models.find((row) => row.id === offering.modelId)?.canonicalName ?? "";
    if (serving.includes(canonicalName)) continue;
    const priority = basePriority * 1000 + UNSERVABLE_OFFSET + behind;
    behind += 1;
    if (offering.disabled && offering.priority === priority) continue;
    await catalog.patchOffering(offering.id, { disabled: true, priority });
    changed += 1;
  }
  return changed;
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
async function ensureOneServes(offerings: HubOffering[], models: HubModel[], serving: readonly string[]): Promise<number> {
  const served = offerings.filter((offering) =>
    serving.includes(models.find((row) => row.id === offering.modelId)?.canonicalName ?? ""),
  );
  if (served.length === 0 || served.some((offering) => !offering.disabled)) return 0;
  for (const offering of served) await catalog.patchOffering(offering.id, { disabled: false });
  return served.length;
}

/**
 * Reads every connected provider's models again for what can answer, and
 * reorders its offerings to match. Run when the host boots, so a workspace
 * connected before the listing was read this way is put right without a
 * reconnect. (Not only on install: the client asks for an install only when
 * the workspace is missing something, which an existing one is not, so a
 * step that lives there alone never runs for the people it is for.)
 * Returns how many offerings were changed.
 */
export async function rerankCatalogProviders(): Promise<number> {
  if (!workspaceOrNull()) return 0;
  let changed = 0;
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
    changed += await retireUnservable(offerings, modelRows, serving, basePriority);
    changed += await ensureOneServes(offerings, modelRows, serving);
    for (const [index, canonicalName] of serving.entries()) {
      const offering = offerings.find((entry) => modelRows.find((model) => model.id === entry.modelId)?.canonicalName === canonicalName);
      if (!offering) continue;
      const priority = basePriority * 1000 + index;
      if (offering.priority !== priority) {
        await catalog.patchOffering(offering.id, { priority });
        changed += 1;
      }
    }
  }
  return changed;
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

