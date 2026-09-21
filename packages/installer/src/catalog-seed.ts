/**
 * Install-time seed of the model catalog from `@intx/inference-catalog`.
 *
 * The hub's `model_provider` row requires exactly one of `credentialId` /
 * `walletId`, so install cannot create connected providers -- there is no key
 * yet. What install CAN create is everything that needs no secret: the vendor
 * `provider` rows (plugin, base URL, and the catalog's offering snapshot in
 * `metadata`) and the `model` rows. The `model_provider` rows and their
 * offerings materialize later, at connect (attach) time, from the snapshot in
 * the vendor row's metadata (`provider-connect.ts`'s attach path). A project
 * inherits all of this through tenant ancestry, so the seed writes to the
 * workspace tenant only -- never a per-project copy.
 *
 * The specs are derived from the live `catalogProviders` / `catalogModels`
 * exports on every call, never hand-copied: a pin refresh flows through
 * without a second edit here. Each catalog provider maps to at most one
 * connect-time vendor row (the overlay below); anything without a connect
 * path is skipped, with its reason recorded in `SEED_SKIP_REASONS`.
 */
import { catalogModels, catalogProviders } from "@intx/inference-catalog";
import type { Transport } from "@intx/hub-client";
import { catalogFor } from "./hub.js";

export type SeedOfferingSpec = {
  /** References a seeded model's canonical name. */
  model: string;
  displayName: string;
  priority: number;
  capabilities: string[];
  quirks: Record<string, unknown>;
};

export type SeededVendorSpec = {
  /** Connect-time vendor name, e.g. "anthropic" -- also the model provider's name at attach. */
  name: string;
  label: string;
  plugin: string;
  baseURL: string;
  offerings: SeedOfferingSpec[];
};

/**
 * Catalog providers that seed a connect-time vendor row, keyed by the
 * catalog's own provider name. The connect names are the ones the client's
 * connect options and existing credentials already use ("anthropic", not
 * "Anthropic Direct"), so a seeded row is adopted -- not duplicated -- when a
 * provider first connects.
 */
const CONNECT_OVERLAY: Record<string, { name: string; label: string }> = {
  "Anthropic Direct": { name: "anthropic", label: "Anthropic" },
  "OpenAI Direct": { name: "openai", label: "OpenAI" },
  "xAI Direct": { name: "xai", label: "xAI (API key)" },
};

/**
 * Why each unseeded catalog provider stays out of the workspace catalog.
 * Every skipped provider is a relay endpoint (a third party's key authenticates
 * to someone else's models) or serves a plugin no connect path offers:
 * - The Kimi relays (Fireworks, Moonshot, OpenRouter) each need that relay's
 *   own key, and the pin's only OpenRouter presence is Kimi -- seeding an
 *   "openrouter" row from it would misrepresent OpenRouter as a Kimi-only
 *   endpoint. OpenRouter as a general endpoint stays available through the
 *   compatible custom-endpoint path, which discovers its models live.
 * - The OpenCode Zen relays are the same shape: relay keys, no connect option.
 * - Gemini Direct serves the `google-genai` plugin, which no API-key connect
 *   option offers; seeding a row nobody can attach to would strand it.
 */
const SEED_SKIP_REASONS: Record<string, string> = {
  "Gemini Direct": "no connect path serves the google-genai plugin",
  "Fireworks Kimi": "relay endpoint needing a Fireworks key, not a first-party connect option",
  "Moonshot Kimi": "relay endpoint needing a Moonshot key, not a first-party connect option",
  "OpenRouter Kimi": "the pin's only OpenRouter presence is Kimi; OpenRouter generally connects via the compatible custom-endpoint path",
  "OpenCode Zen v1": "relay endpoint needing an OpenCode Zen key, not a first-party connect option",
  "OpenCode Zen Go v1": "relay endpoint needing an OpenCode Zen key, not a first-party connect option",
};

/** Every catalog provider accounted for: seeded under a connect name, or skipped with a documented reason. */
function assertCatalogCoverage(): void {
  for (const spec of catalogProviders) {
    if (CONNECT_OVERLAY[spec.name] === undefined && SEED_SKIP_REASONS[spec.name] === undefined) {
      throw new Error(
        `catalog-seed: catalog provider "${spec.name}" is neither seeded nor skipped -- add it to CONNECT_OVERLAY or SEED_SKIP_REASONS`,
      );
    }
  }
}

function displayNameFor(canonicalName: string): string {
  return catalogModels.find((model) => model.canonicalName === canonicalName)?.displayName ?? canonicalName;
}

/** The vendor rows this install seeds, derived from the live catalog pin. */
export function seededVendorSpecs(): SeededVendorSpec[] {
  assertCatalogCoverage();
  const specs: SeededVendorSpec[] = [];
  for (const provider of catalogProviders) {
    const overlay = CONNECT_OVERLAY[provider.name];
    if (!overlay) continue;
    specs.push({
      name: overlay.name,
      label: overlay.label,
      plugin: provider.plugin,
      baseURL: provider.baseURL,
      offerings: provider.offerings.map((offering) => ({
        model: offering.model,
        displayName: displayNameFor(offering.model),
        priority: offering.priority,
        capabilities: [...offering.capabilities],
        quirks: { ...offering.quirks },
      })),
    });
  }
  return specs;
}

/** The seed spec for a connect-time vendor name, if the catalog seeds one. */
export function seededVendorSpec(name: string): SeededVendorSpec | undefined {
  return seededVendorSpecs().find((spec) => spec.name === name);
}

export type SeedCatalogResult = {
  /** Connect-time vendor names ensured on the workspace tenant. */
  providers: string[];
  /** Canonical model names ensured on the workspace tenant. */
  models: string[];
};

/**
 * Seeds the workspace tenant's catalog: one vendor `provider` row per seeded
 * spec (carrying the offering snapshot in `metadata.offeringSpecs` for the
 * attach path to materialize) plus one `model` row per offered model.
 * Idempotent and adopting: rows found by name (vendor) or canonical name
 * (model) are reused as-is, never rewritten -- a tenant-added row or a
 * hand-edited label survives a re-run. The one exception is a vendor row that
 * predates the seed and carries no snapshot: it is backfilled with the specs
 * (preserving its other metadata), so providers connected before the seed
 * existed still attach from the snapshot.
 */
export async function seedCatalog(transport: Transport, workspaceTenantId: string): Promise<SeedCatalogResult> {
  const catalog = catalogFor(transport, workspaceTenantId);
  const specs = seededVendorSpecs();
  const [vendorRows, modelRows] = await Promise.all([catalog.providers(), catalog.models()]);

  const providers: string[] = [];
  const models: string[] = [];
  for (const spec of specs) {
    const existing = vendorRows.find((row) => row.name === spec.name);
    if (!existing) {
      vendorRows.push(
        await catalog.createProvider({
          name: spec.name,
          plugin: spec.plugin,
          apiBaseUrl: spec.baseURL,
          metadata: { label: spec.label, catalogSeeded: true, offeringSpecs: spec.offerings },
        }),
      );
    } else if (!isSeedSnapshot((existing.metadata ?? null) as Record<string, unknown> | null)) {
      const metadata = { ...(existing.metadata ?? {}) };
      if (typeof metadata["label"] !== "string") metadata["label"] = spec.label;
      metadata["catalogSeeded"] = true;
      metadata["offeringSpecs"] = spec.offerings;
      Object.assign(existing, await catalog.patchProvider(existing.id, { metadata }));
    }
    providers.push(spec.name);

    for (const offering of spec.offerings) {
      const modelRow = modelRows.find((row) => row.canonicalName === offering.model);
      if (!modelRow) {
        modelRows.push(await catalog.createModel({ canonicalName: offering.model, displayName: offering.displayName }));
      }
      if (!models.includes(offering.model)) models.push(offering.model);
    }
  }
  return { providers, models };
}

function isSeedSnapshot(metadata: Record<string, unknown> | null): boolean {
  return Array.isArray(metadata?.["offeringSpecs"]);
}
