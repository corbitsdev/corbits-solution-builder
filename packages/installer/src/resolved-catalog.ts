/**
 * Resolved-catalog rows for the Settings Inference panel.
 *
 * The panel renders the resolved read model -- one row per model in fallback
 * order from `GET /api/tenants/:id/models` -- and every write goes through
 * the existing catalog PATCH wrappers in `hub.ts`. No new routes, no
 * guard/ledger changes; the seed/default semantics are consumed as-is.
 */
import {
  catalogFor,
  type HubCredential,
  type HubModel,
  type HubModelProvider,
  type HubOffering,
  
  type Transport,
} from "./hub.js";
import { computeMakeDefaultPatches } from "./model-default.js";

/** The capability marker a chat-capable offering carries. */
export const CHAT_CAPABILITY = "plain-text";

/** "gpt-4o" reads better in a row than a bare vendor id. */
export function shortModelName(canonicalName: string): string {
  const slash = canonicalName.lastIndexOf("/");
  return slash >= 0 ? canonicalName.slice(slash + 1) : canonicalName;
}

export function isChatCapable(capabilities: readonly string[]): boolean {
  return capabilities.includes(CHAT_CAPABILITY);
}

/** One resolved `GET /models` entry: the model plus its visible offerings. */
export type ResolvedCatalogModelInput = {
  id: string;
  canonicalName: string;
  displayName: string | null;
  offerings: Array<{
    offeringId: string;
    providerId: string;
    providerName: string;
    priority: number;
    capabilities: readonly string[];
  }>;
};

/** Everything the row builder merges: the resolved response plus raw tables. */
export type ResolvedCatalogInput = {
  /** `GET /models` response order is the fallback order. Rows follow it. */
  resolved: ResolvedCatalogModelInput[];
  models: HubModel[];
  offerings: HubOffering[];
  modelProviders: HubModelProvider[];
  credentials: HubCredential[];
};

/**
 * One rendered row. `restricted` rows stay visible with a badge -- they are
 * never default candidates and can be unrestricted again. `chatCapable` is
 * false for models whose visible offerings lack the chat marker (badged "Not
 * chat", never chat default).
 */
export type ResolvedCatalogRow = {
  modelId: string;
  canonicalName: string;
  displayName: string | null;
  providerNames: string[];
  /** Min visible-offering priority; the row's fallback rank. */
  priority: number;
  isDefault: boolean;
  restricted: boolean;
  shadowed: boolean;
  chatCapable: boolean;
  defaultCandidate: boolean;
  /** Boolean only -- never a secret. */
  credentialConnected: boolean;
  /** Offering row ids to PATCH for default/reorder/restrict. */
  offeringIds: string[];
  /** Model-provider row ids to PATCH for shadow (empty: shadow unsupported). */
  providerRowIds: string[];
};

/**
 * Build render rows from the resolved response plus the raw catalog tables.
 * Response order is preserved (that IS the fallback order). Models that have
 * catalog offerings but no visible offerings are appended as `restricted`
 * rows so the panel can unrestrict them; models with no offerings at all are
 * omitted (nothing to manage, never simulated rows).
 */
export function buildResolvedCatalogRows(input: ResolvedCatalogInput): ResolvedCatalogRow[] {
  const credentialsById = new Map(input.credentials.map((credential) => [credential.id, credential]));
  const providerRowsById = new Map(input.modelProviders.map((provider) => [provider.id, provider]));
  const rawOfferingsByModel = new Map<string, HubOffering[]>();
  for (const offering of input.offerings) {
    const list = rawOfferingsByModel.get(offering.modelId) ?? [];
    list.push(offering);
    rawOfferingsByModel.set(offering.modelId, list);
  }
  const visibleModelIds = new Set(input.resolved.map((model) => model.id));

  /**
   * Label + boolean credential status for the endpoint serving an offering.
   * The fallback keeps discovery-shaped rows renderable when their provider
   * row is missing (shadow then unsupported for that row).
   */
  const describeServingProvider = (
    modelProviderRowId: string,
    fallbackLabel: string,
  ): { label: string; connected: boolean; shadowed: boolean; rowId: string | null } => {
    const row = providerRowsById.get(modelProviderRowId);
    if (row == null) return { label: fallbackLabel, connected: false, shadowed: false, rowId: null };
    const credential = row.credentialId == null ? undefined : credentialsById.get(row.credentialId);
    return {
      label: row.name || fallbackLabel,
      connected: credential?.status === "active",
      shadowed: row.disabled,
      rowId: row.id,
    };
  };

  const rows: ResolvedCatalogRow[] = [];
  for (const model of input.resolved) {
    const providerIds = [...new Set(model.offerings.map((offering) => offering.offeringId))];
    const rawForModel = rawOfferingsByModel.get(model.id) ?? [];
    const rawById = new Map(rawForModel.map((offering) => [offering.id, offering]));
    const providerNames: string[] = [];
    const providerRowIds: string[] = [];
    let credentialConnected = false;
    let allProvidersShadowed = model.offerings.length > 0;
    for (const offering of model.offerings) {
      const raw = rawById.get(offering.offeringId);
      const info = describeServingProvider(
        raw?.providerId ?? offering.providerId,
        offering.providerName,
      );
      if (!providerNames.includes(info.label)) providerNames.push(info.label);
      if (info.rowId != null && !providerRowIds.includes(info.rowId)) providerRowIds.push(info.rowId);
      credentialConnected ||= info.connected;
      allProvidersShadowed &&= info.shadowed;
    }
    const priorities = model.offerings.map((offering) => offering.priority);
    rows.push({
      modelId: model.id,
      canonicalName: model.canonicalName,
      displayName: model.displayName,
      providerNames,
      priority: Math.min(...priorities),
      isDefault: false,
      restricted: false,
      shadowed: allProvidersShadowed && providerRowIds.length > 0,
      chatCapable: model.offerings.some((offering) => isChatCapable(offering.capabilities)),
      defaultCandidate: false,
      credentialConnected,
      offeringIds: providerIds,
      providerRowIds,
    });
  }

  // Restricted rows: catalog models with offerings but nothing visible. They
  // keep their raw priority order after the resolved rows.
  const restrictedModels = input.models
    .filter((model) => !visibleModelIds.has(model.id))
    .filter((model) => (rawOfferingsByModel.get(model.id) ?? []).length > 0)
    .sort((left, right) => {
      const rank = (model: HubModel): number =>
        Math.min(...(rawOfferingsByModel.get(model.id) ?? []).map((offering) => offering.priority));
      return rank(left) - rank(right);
    });
  for (const model of restrictedModels) {
    const rawForModel = rawOfferingsByModel.get(model.id) ?? [];
    const providerNames: string[] = [];
    const providerRowIds: string[] = [];
    let credentialConnected = false;
    let allProvidersShadowed = rawForModel.length > 0;
    let allOfferingsRestricted = rawForModel.length > 0;
    for (const offering of rawForModel) {
      allOfferingsRestricted &&= offering.disabled;
      const info = describeServingProvider(offering.providerId, shortModelName(offering.providerId));
      if (!providerNames.includes(info.label)) providerNames.push(info.label);
      if (info.rowId != null && !providerRowIds.includes(info.rowId)) providerRowIds.push(info.rowId);
      credentialConnected ||= info.connected;
      allProvidersShadowed &&= info.shadowed;
    }
    rows.push({
      modelId: model.id,
      canonicalName: model.canonicalName,
      displayName: model.displayName,
      providerNames,
      priority: Math.min(...rawForModel.map((offering) => offering.priority)),
      isDefault: false,
      restricted: allOfferingsRestricted || allProvidersShadowed,
      shadowed: allProvidersShadowed && providerRowIds.length > 0,
      chatCapable: rawForModel.some((offering) => isChatCapable(offering.capabilities)),
      defaultCandidate: false,
      credentialConnected,
      offeringIds: rawForModel.map((offering) => offering.id),
      providerRowIds,
    });
  }

  // The default badge is chat-scoped: the lowest-priority row that may answer
  // chat. (resolveActiveModel itself takes the min across every offering; the
  // panel only ever offers chat-capable rows as candidates, so the badge
  // marks the candidate the next chat turn would prefer.)
  const candidates = rows.filter((row) => !row.restricted && row.chatCapable);
  if (candidates.length > 0) {
    const winner = candidates.reduce((best, row) => (row.priority < best.priority ? row : best));
    for (const row of rows) row.isDefault = row === winner;
  }
  for (const row of rows) row.defaultCandidate = !row.restricted && row.chatCapable;
  return rows;
}

/**
 * Make a model the chat default: rewrite head priorities through
 * `computeMakeDefaultPatches` and PATCH each affected offering.
 */
export async function makeResolvedModelDefault(
  transport: Transport,
  scope: string,
  targetModelId: string,
): Promise<void> {
  const catalog = catalogFor(transport, scope);
  const offerings = await catalog.offerings();
  const patches = computeMakeDefaultPatches(
    offerings.map((offering) => ({
      id: offering.id,
      modelId: offering.modelId,
      priority: offering.priority,
      disabled: offering.disabled,
    })),
    targetModelId,
  );
  for (const patch of patches) {
    await catalog.patchOffering(patch.id, { priority: patch.priority });
  }
}

export type ModelMoveDirection = "up" | "down";

/**
 * Move a visible model one step in fallback order by swapping its head
 * priority with the neighbour's. Restricted rows have no rank and cannot
 * move (returns false, patches nothing).
 */
export async function moveResolvedModel(
  transport: Transport,
  scope: string,
  targetModelId: string,
  direction: ModelMoveDirection,
): Promise<boolean> {
  const catalog = catalogFor(transport, scope);
  const offerings = await catalog.offerings();
  const enabled = offerings.filter((offering) => !offering.disabled);
  const heads = new Map<string, HubOffering>();
  for (const offering of enabled) {
    const current = heads.get(offering.modelId);
    if (current == null || offering.priority < current.priority) heads.set(offering.modelId, offering);
  }
  const order = [...heads.values()].sort((left, right) => left.priority - right.priority);
  const index = order.findIndex((offering) => offering.modelId === targetModelId);
  if (index < 0) return false;
  const neighbour = direction === "up" ? order[index - 1] : order[index + 1];
  const head = order[index];
  if (neighbour == null || head == null || neighbour.priority === head.priority) return false;
  await catalog.patchOffering(head.id, { priority: neighbour.priority });
  await catalog.patchOffering(neighbour.id, { priority: head.priority });
  return true;
}

/**
 * Restrict a model (disable every offering) or lift the restriction (enable
 * every offering). Only offerings that need the change are patched.
 */
export async function setResolvedModelRestricted(
  transport: Transport,
  scope: string,
  targetModelId: string,
  restricted: boolean,
): Promise<number> {
  const catalog = catalogFor(transport, scope);
  const offerings = await catalog.offerings();
  const targets = offerings.filter(
    (offering) => offering.modelId === targetModelId && offering.disabled !== restricted,
  );
  for (const offering of targets) {
    await catalog.patchOffering(offering.id, { disabled: restricted });
  }
  return targets.length;
}

/**
 * Shadow (or unshadow) the providers serving a model by flipping their
 * disabled flag. Only the disabled flag is ever written.
 */
export async function setResolvedModelShadowed(
  transport: Transport,
  scope: string,
  providerRowIds: readonly string[],
  shadowed: boolean,
): Promise<number> {
  const catalog = catalogFor(transport, scope);
  const providers = await catalog.modelProviders();
  const targets = providers.filter(
    (provider) => providerRowIds.includes(provider.id) && provider.disabled !== shadowed,
  );
  for (const provider of targets) {
    await catalog.patchModelProvider(provider.id, { disabled: shadowed });
  }
  return targets.length;
}
