/**
 * The model catalog, in Interchange's own tables.
 *
 * A connected provider is not just a secret the host holds. Interchange models
 * this natively: `model_provider` names the adapter and base URL and points at
 * the `credential` row (never the material), `model` names each canonical model
 * the tenant can ask for, and `model_offering` says which provider serves which
 * model, in what order, with which capabilities.
 *
 * This is what links a credential seeded at onboarding to the capabilities
 * being deployed: a workflow definition declares `modelRequirements` by
 * canonical name, and resolution walks the tenant's offerings to a
 * credential-bearing source. Without these rows a definition can require a
 * model and the hub has nothing to resolve it against.
 *
 * This module is the only place in Solutions Builder allowed to import
 * `@intx/db/schema` — `providers.ts` reads and writes
 * the catalog only through the functions exported here.
 */
import { and, eq } from "drizzle-orm";
import { hub, hubIsMounted } from "./hub-mount.js";
import { LOCAL_TENANT } from "./projects.js";
import { catalogModels, catalogProviders } from "@intx/inference-catalog";

/** The adapter Interchange dispatches a provider's inference through. */
export type Plugin = "anthropic" | "openai" | "openai-compatible" | "google-genai";

type Row = Record<string, unknown>;
type Handle = {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Row[]>;
    };
  };
  insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
  update: (table: unknown) => {
    set: (row: unknown) => { where: (predicate: unknown) => Promise<unknown> };
  };
  delete: (table: unknown) => { where: (predicate: unknown) => Promise<unknown> };
};

// The vendored schema is declared opaquely in `types/intx.d.ts`, so columns
// are named explicitly rather than inferred.
type Col = never;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function schemaTables() {
  return (await import("@intx/db/schema")) as unknown as {
    provider: unknown;
    credential: unknown;
    model: unknown;
    modelProvider: unknown;
    modelOffering: unknown;
  };
}

function handle(): Handle {
  return hub().db.db as unknown as Handle;
}

/**
 * The capabilities and quirks a model offering carries, drawn from the
 * discovery support matrix baked into `@intx/inference-catalog` — never
 * guessed at connection time.
 *
 * A model the catalog does not know (a local endpoint's own model, an
 * unlisted relay) gets the smallest honest claim: plain text, nothing else.
 * Everything else — tool calls, streaming, vision — is a claim this build has
 * not verified for that model, and is not asserted.
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
  // Fallback: this build has not verified anything beyond plain text for a
  // model the catalog does not carry.
  return { capabilities: ["plain-text"], quirks: null };
}

export function catalogDisplayNameFor(canonicalName: string): string {
  return catalogModels.find((entry) => entry.canonicalName === canonicalName)?.displayName
    ?? canonicalName;
}

/**
 * Records a connected provider and everything it can serve.
 *
 * Idempotent by natural key — `(tenant, provider name)` and
 * `(tenant, canonical model name)` are both unique upstream — so reconnecting
 * a provider updates its row rather than accumulating duplicates.
 *
 * Requires a real credential: `model_provider` enforces exactly one of
 * `credentialId` or `walletId`, and a local endpoint has neither. Callers for
 * a local endpoint do not reach this function at all — see `localProvider` in
 * `host/db/schema.ts`.
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
  const { model, modelProvider, modelOffering } = await schemaTables();
  const db = handle();

  const providerColumns = modelProvider as unknown as { tenantId: Col; name: Col };
  const name = slug(input.providerId);
  const [existingProvider] = await db
    .select()
    .from(modelProvider)
    .where(and(eq(providerColumns.tenantId, LOCAL_TENANT), eq(providerColumns.name, name)));

  const providerRow = {
    tenantId: LOCAL_TENANT,
    name,
    plugin: input.plugin,
    baseURL: input.baseUrl,
    credentialId: input.credentialId,
    walletId: null,
    disabled: false,
  };

  let providerRowId: string;
  if (existingProvider) {
    providerRowId = String(existingProvider.id);
    await db
      .update(modelProvider)
      .set(providerRow)
      .where(eq((modelProvider as unknown as { id: Col }).id, providerRowId));
  } else {
    providerRowId = `mpv_${name}`;
    await db.insert(modelProvider).values({ id: providerRowId, ...providerRow });
  }

  const modelColumns = model as unknown as { tenantId: Col; canonicalName: Col };
  const offeringColumns = modelOffering as unknown as {
    tenantId: Col;
    modelId: Col;
    providerId: Col;
  };

  let offerings = 0;
  for (const [index, canonicalName] of input.models.entries()) {
    const [existingModel] = await db
      .select()
      .from(model)
      .where(
        and(eq(modelColumns.tenantId, LOCAL_TENANT), eq(modelColumns.canonicalName, canonicalName)),
      );

    const modelId = existingModel ? String(existingModel.id) : `mdl_${slug(canonicalName)}`;
    if (!existingModel) {
      await db.insert(model).values({
        id: modelId,
        tenantId: LOCAL_TENANT,
        canonicalName,
        displayName: catalogDisplayNameFor(canonicalName),
        disabled: false,
      });
    }

    const [existingOffering] = await db
      .select()
      .from(modelOffering)
      .where(
        and(
          eq(offeringColumns.tenantId, LOCAL_TENANT),
          eq(offeringColumns.modelId, modelId),
          eq(offeringColumns.providerId, providerRowId),
        ),
      );

    const { capabilities, quirks } = catalogCapabilitiesFor(canonicalName, input.plugin);
    const offeringRow = {
      tenantId: LOCAL_TENANT,
      modelId,
      providerId: providerRowId,
      // The operator's provider order decides which offering wins; within one
      // provider the order the models were discovered in is the tiebreak.
      priority: (input.priority ?? 0) * 1000 + index,
      capabilities,
      quirks,
      // Reconnecting must not silently re-enable an offering the operator
      // narrowed to a single selected model, so a fresh row starts enabled
      // and an existing one keeps whatever `setCatalogSelectedModel` left it.
      disabled: existingOffering ? Boolean(existingOffering.disabled) : false,
    };

    if (existingOffering) {
      await db
        .update(modelOffering)
        .set(offeringRow)
        .where(eq((modelOffering as unknown as { id: Col }).id, String(existingOffering.id)));
    } else {
      await db
        .insert(modelOffering)
        .values({ id: `mof_${slug(canonicalName)}-${name}`, ...offeringRow });
    }
    offerings += 1;
  }

  return { providerRowId, offerings };
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
  kind: "api_key" | "oauth";
  credentialId: string;
  /** From `credential.status`: "active" reads as ready, anything else as-is. */
  status: string;
  validatedAt: Date | null;
  /** Lowest first — the operator's order of preference. */
  basePriority: number;
  models: CatalogModelRow[];
};

/** All providers with a real credential, for the local tenant, unordered. */
export async function listCatalogProviders(): Promise<CatalogProviderRow[]> {
  // A hosted hub is a separate database this process has no direct handle to
  // — every other read of it goes through `hubFetch`'s HTTP path
  // (`hub-endpoint.ts`), which this reader does not yet. Reporting
  // "no connected providers" here is honest for what this process can see;
  // it must not read as "the platform lost every connection".
  if (!hubIsMounted()) return [];

  const { provider, credential, model, modelProvider, modelOffering } = await schemaTables();
  const db = handle();

  const tenantColumn = (table: unknown) => (table as unknown as { tenantId: Col }).tenantId;

  const [providerRows, credentialRows, modelRows, offeringRows, vendorRows] = await Promise.all([
    db.select().from(modelProvider).where(eq(tenantColumn(modelProvider), LOCAL_TENANT)),
    db.select().from(credential).where(eq(tenantColumn(credential), LOCAL_TENANT)),
    db.select().from(model).where(eq(tenantColumn(model), LOCAL_TENANT)),
    db.select().from(modelOffering).where(eq(tenantColumn(modelOffering), LOCAL_TENANT)),
    db.select().from(provider).where(eq(tenantColumn(provider), LOCAL_TENANT)),
  ]);

  const credentialById = new Map(credentialRows.map((row) => [String(row.id), row]));
  const modelById = new Map(modelRows.map((row) => [String(row.id), row]));
  const vendorByName = new Map(vendorRows.map((row) => [String(row.name), row]));

  return providerRows.map((row) => {
    const providerRowId = String(row.id);
    const credentialRow = credentialById.get(String(row.credentialId));
    const vendorRow = vendorByName.get(String(row.name));
    const metadata = (vendorRow?.metadata as { label?: string } | null) ?? null;

    const models = offeringRows
      .filter((offering) => String(offering.providerId) === providerRowId)
      .map((offering): CatalogModelRow => {
        const modelRow = modelById.get(String(offering.modelId));
        const canonicalName = String(modelRow?.canonicalName ?? "");
        return {
          offeringId: String(offering.id),
          canonicalName,
          displayName: String(modelRow?.displayName ?? canonicalName),
          priority: Number(offering.priority),
          capabilities: (offering.capabilities as string[]) ?? [],
          disabled: Boolean(offering.disabled),
        };
      })
      .sort((a, b) => a.priority - b.priority);

    const basePriority = models.length > 0 ? Math.floor(models[0]!.priority / 1000) : 0;

    return {
      providerRowId,
      providerId: String(row.name),
      label: metadata?.label ?? String(row.name),
      plugin: row.plugin as Plugin,
      baseUrl: String(row.baseURL ?? ""),
      kind: credentialRow?.type === "oauth_token" ? "oauth" : "api_key",
      credentialId: String(row.credentialId ?? ""),
      status: credentialRow?.status === "active" ? "ready" : String(credentialRow?.status ?? "error"),
      validatedAt: credentialRow?.updatedAt ? new Date(credentialRow.updatedAt as string) : null,
      basePriority,
      models,
    };
  });
}

export async function getCatalogProvider(providerId: string): Promise<CatalogProviderRow | null> {
  const name = slug(providerId);
  const providers = await listCatalogProviders();
  return providers.find((row) => row.providerId === name) ?? null;
}

/** The keychain reference the operator's provider authenticates with. */
export async function getCredentialRef(providerId: string): Promise<string | null> {
  const { credential } = await schemaTables();
  const db = handle();
  const columns = credential as unknown as { tenantId: Col; name: Col };
  const [row] = await db
    .select()
    .from(credential)
    .where(
      and(eq(columns.tenantId, LOCAL_TENANT), eq(columns.name, `provider:${providerId}`)),
    );
  return row ? String(row.secret) : null;
}

/** Marks a credential validated again — after a successful models refresh. */
export async function touchCredentialValidated(providerId: string): Promise<void> {
  const { credential } = await schemaTables();
  const db = handle();
  const columns = credential as unknown as { tenantId: Col; name: Col };
  const [row] = await db
    .select()
    .from(credential)
    .where(
      and(eq(columns.tenantId, LOCAL_TENANT), eq(columns.name, `provider:${providerId}`)),
    );
  if (!row) return;
  await db
    .update(credential)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq((credential as unknown as { id: Col }).id, String(row.id)));
}

/**
 * Reorders a connected provider: every offering it carries moves to the new
 * base, keeping the relative order they were discovered in.
 */
export async function setCatalogProviderPriority(
  providerId: string,
  basePriority: number,
): Promise<void> {
  const { modelOffering } = await schemaTables();
  const db = handle();
  const providerRow = await getCatalogProvider(providerId);
  if (!providerRow) return;
  const columns = modelOffering as unknown as { id: Col };
  const ordered = [...providerRow.models].sort((a, b) => a.priority - b.priority);
  for (const [index, entry] of ordered.entries()) {
    await db
      .update(modelOffering)
      .set({ priority: basePriority * 1000 + index })
      .where(eq(columns.id, entry.offeringId));
  }
}

/**
 * Records the operator's chosen model: every other offering this provider
 * carries is disabled, so resolution can only land on the one they picked.
 * `null` clears the choice and re-enables every offering — "best available".
 */
export async function setCatalogSelectedModel(
  providerId: string,
  canonicalName: string | null,
): Promise<void> {
  const { modelOffering } = await schemaTables();
  const db = handle();
  const providerRow = await getCatalogProvider(providerId);
  if (!providerRow) return;
  const columns = modelOffering as unknown as { id: Col };
  for (const entry of providerRow.models) {
    const disabled = canonicalName !== null && entry.canonicalName !== canonicalName;
    await db.update(modelOffering).set({ disabled }).where(eq(columns.id, entry.offeringId));
  }
}

/** Removes a connected provider's offerings, its adapter row, and its credential. */
export async function disconnectCatalogProvider(providerId: string): Promise<void> {
  const { modelOffering, modelProvider, credential } = await schemaTables();
  const db = handle();
  const providerRow = await getCatalogProvider(providerId);
  if (!providerRow) return;

  const offeringColumns = modelOffering as unknown as { id: Col };
  for (const entry of providerRow.models) {
    await db.delete(modelOffering).where(eq(offeringColumns.id, entry.offeringId));
  }
  await db
    .delete(modelProvider)
    .where(eq((modelProvider as unknown as { id: Col }).id, providerRow.providerRowId));
  if (providerRow.credentialId) {
    await db
      .delete(credential)
      .where(eq((credential as unknown as { id: Col }).id, providerRow.credentialId));
  }
}
