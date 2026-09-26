/**
 * The model catalog a tenant can see, not merely the rows it owns.
 *
 * The catalog routes (`/catalog/offerings`, `/catalog/providers`,
 * `/catalog/models`) list a tenant's OWN rows. A project is a child tenant
 * whose catalog is empty: it inherits the workspace's through tenant
 * ancestry, and that is the catalog the hub resolves a deploy's
 * `sourceOfferingIds` against (`listVisibleOfferings` in the vendored
 * `catalog-resolution.ts`). This mirrors that read: walk `parentId` to the
 * root, list every tenant's rows, and let a nearer tenant's row shadow a
 * farther one with the same (model, provider) identity. Disabled rows are
 * dropped, as the hub drops them.
 *
 * Read-only, and never a permission check: whether the deploying principal
 * may USE an inherited offering's credential (`credential:<id>/use`, the
 * owner's delegation choice at project creation) stays the hub's decision at
 * deploy time. This only lets the installer name the offerings the hub will
 * then judge.
 */
import type { Transport } from "@intx/hub-client";
import { catalogFor, getTenant, type HubModel, type HubModelProvider, type HubOffering, type HubTenant } from "./hub.js";

export type VisibleCatalog = {
  /** Enabled offerings, nearest tenant's row first per identity. */
  readonly offerings: readonly HubOffering[];
  readonly modelProviders: readonly HubModelProvider[];
  readonly models: readonly HubModel[];
};

/** `tenantId` first, then each parent up to the root. */
export async function tenantChain(transport: Transport, tenant: HubTenant | string): Promise<string[]> {
  const seen = new Set<string>();
  const chain: string[] = [];
  let current: HubTenant | null = typeof tenant === "string" ? await getTenant(transport, tenant) : tenant;
  if (!current && typeof tenant === "string") return [tenant];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.id);
    if (!current.parentId) break;
    current = await getTenant(transport, current.parentId);
  }
  return chain;
}

function dedupe<T extends { readonly id: string }>(rows: readonly T[], keyOf: (row: T) => string | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row) ?? `id:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Every catalog row `tenant` can see, its own first. A workspace (no parent)
 * reads exactly what it reads today; a project reads its own rows, if any,
 * merged over the workspace's.
 */
export async function visibleCatalog(transport: Transport, tenant: HubTenant | string): Promise<VisibleCatalog> {
  const chain = await tenantChain(transport, tenant);
  const perTenant = await Promise.all(
    chain.map(async (tenantId) => {
      const catalog = catalogFor(transport, tenantId);
      const [offerings, modelProviders, models] = await Promise.all([
        catalog.offerings(),
        catalog.modelProviders(),
        catalog.models(),
      ]);
      return { offerings, modelProviders, models };
    }),
  );
  const models = dedupe(
    perTenant.flatMap((entry) => entry.models),
    (row) => row.canonicalName,
  );
  const modelProviders = dedupe(
    perTenant.flatMap((entry) => entry.modelProviders),
    (row) => row.name,
  ).filter((row) => !row.disabled);
  // Referents may live on any tenant in the chain, so identity is resolved
  // over every row read, shadowed or not; visibility is decided after.
  const modelNameById = new Map(perTenant.flatMap((entry) => entry.models).map((row) => [row.id, row.canonicalName]));
  const providerNameById = new Map(
    perTenant.flatMap((entry) => entry.modelProviders).map((row) => [row.id, row.name]),
  );
  const visibleModels = new Set(models.map((row) => row.canonicalName));
  const visibleProviders = new Set(modelProviders.map((row) => row.name));
  const offerings = dedupe(
    perTenant.flatMap((entry) => entry.offerings),
    (row) => {
      const model = modelNameById.get(row.modelId);
      const provider = providerNameById.get(row.providerId);
      return model === undefined || provider === undefined ? undefined : `${model}\u0000${provider}`;
    },
  ).filter((row) => {
    if (row.disabled) return false;
    const model = modelNameById.get(row.modelId);
    const provider = providerNameById.get(row.providerId);
    return model !== undefined && provider !== undefined && visibleModels.has(model) && visibleProviders.has(provider);
  });
  return { offerings, modelProviders, models };
}
