/**
 * What the workspace has spent on inference, read from the one place it is
 * actually recorded: `EventCollectorRegistry`'s `onUsage` sink
 * (`vendor/interchange/packages/hub-sessions/src/event-collector-registry.ts`),
 * which fires one `TurnUsage` (tenantId, provider, model, token counts) per
 * finished inference turn, for every round a sidecar runs.
 *
 * Nothing else in this revision of Interchange persists a call's tokens: the
 * `model_pricing` table (`vendor/interchange/packages/db/src/schema/catalog.ts`)
 * prices a model, but no table records that a call happened. So this store
 * is process memory, not a ledger row -- it holds what this process has
 * seen since it started, and is empty again after a restart. That is said
 * plainly in the mounted response (`sinceRestart: true`) rather than left
 * implicit.
 *
 * Per-project attribution is NOT in scope here: `TurnUsage.runId` names a
 * workflow run, and this codebase has no mapping from a run id to the
 * project id the browser knows (unlike main, which folds usage onto a
 * project's own ledger session). The mount below is workspace-wide only.
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { AnyDb } from "@intx/db";
import type { TenantEnv } from "@intx/hub-api";

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
};

export type TurnUsage = {
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  provider: string;
  model: string;
  usage: TokenCounts;
};

type ProviderModelKey = string;

type Accumulated = {
  provider: string;
  model: string;
  calls: number;
  tokens: TokenCounts;
};

function keyFor(provider: string, model: string): ProviderModelKey {
  return `${provider}\u0000${model}`;
}

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function addTokens(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.thinking += from.thinking;
}

/**
 * The process-lifetime usage store: one map of accumulated per-provider,
 * per-model totals per tenant. `record` is what `onUsage` calls; `forTenant`
 * is what the mounted route reads.
 */
export type SpendStore = {
  record(usage: TurnUsage): void;
  forTenant(tenantId: string): Accumulated[];
};

export function createSpendStore(): SpendStore {
  const byTenant = new Map<string, Map<ProviderModelKey, Accumulated>>();
  return {
    record(usage) {
      let rows = byTenant.get(usage.tenantId);
      if (!rows) {
        rows = new Map();
        byTenant.set(usage.tenantId, rows);
      }
      const key = keyFor(usage.provider, usage.model);
      const row = rows.get(key) ?? { provider: usage.provider, model: usage.model, calls: 0, tokens: emptyTokens() };
      row.calls += 1;
      addTokens(row.tokens, usage.usage);
      rows.set(key, row);
    },
    forTenant(tenantId) {
      return [...(byTenant.get(tenantId)?.values() ?? [])];
    },
  };
}

export type ModelPrice = {
  currency: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
};

const number = (value: string | null | undefined): number => (value ? Number(value) || 0 : 0);

type ModelRow = { id: string; canonicalName: string };
type OfferingRow = { id: string; modelId: string };
type PricingRow = {
  offeringId: string;
  currency: string;
  effectiveFrom: string;
  inputTokenPrice: string | null;
  outputTokenPrice: string | null;
  cacheReadTokenPrice: string | null;
  cacheWriteTokenPrice: string | null;
  thinkingTokenPrice: string | null;
};

/**
 * The active price per model canonical name, for a tenant's own catalog
 * rows. Raw SQL, matching the rest of this package (`workflow-artifact-tokens.ts`):
 * the hand-maintained `@intx/db` type stub carries no drizzle schema for
 * `model`/`model_offering`/`model_pricing` to query-build against.
 */
async function pricesByModel(db: AnyDb, tenantId: string): Promise<Map<string, ModelPrice>> {
  const prices = new Map<string, ModelPrice>();
  const models = (
    await db.execute<ModelRow>(sql`
      SELECT "id", "canonical_name" AS "canonicalName" FROM "model" WHERE "tenant_id" = ${tenantId}
    `)
  ).rows;
  const offerings = (
    await db.execute<OfferingRow>(sql`
      SELECT "id", "model_id" AS "modelId" FROM "model_offering" WHERE "tenant_id" = ${tenantId}
    `)
  ).rows;
  const pricingRows = (
    await db.execute<PricingRow>(sql`
      SELECT "offering_id" AS "offeringId", "currency", "effective_from" AS "effectiveFrom",
             "input_token_price" AS "inputTokenPrice", "output_token_price" AS "outputTokenPrice",
             "cache_read_token_price" AS "cacheReadTokenPrice", "cache_write_token_price" AS "cacheWriteTokenPrice",
             "thinking_token_price" AS "thinkingTokenPrice"
      FROM "model_pricing" WHERE "tenant_id" = ${tenantId}
    `)
  ).rows;
  const names = new Map(models.map((m) => [m.id, m.canonicalName]));
  const now = new Date().toISOString();
  for (const offering of offerings) {
    const name = names.get(offering.modelId);
    if (!name || prices.has(name)) continue;
    const active = pricingRows
      .filter((row) => row.offeringId === offering.id && row.effectiveFrom <= now)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (!active) continue;
    prices.set(name, {
      currency: active.currency,
      input: number(active.inputTokenPrice),
      output: number(active.outputTokenPrice),
      cacheRead: number(active.cacheReadTokenPrice),
      cacheWrite: number(active.cacheWriteTokenPrice),
      thinking: number(active.thinkingTokenPrice),
    });
  }
  return prices;
}

export type SpendByProvider = {
  provider: string;
  model: string;
  calls: number;
  tokens: TokenCounts;
  cost: number | null;
};

export type WorkspaceSpend = {
  sinceRestart: true;
  rows: SpendByProvider[];
  totals: { calls: number; tokens: TokenCounts; cost: number; currency: string };
  unpriced: number;
};

async function summarize(db: AnyDb, tenantId: string, store: SpendStore): Promise<WorkspaceSpend> {
  const prices = await pricesByModel(db, tenantId);
  const accumulated = store.forTenant(tenantId);
  const totals = { calls: 0, tokens: emptyTokens(), cost: 0, currency: "USD" };
  let unpriced = 0;
  const rows: SpendByProvider[] = accumulated.map((row) => {
    const price = prices.get(row.model);
    let cost: number | null = null;
    if (price) {
      cost =
        row.tokens.input * price.input +
        row.tokens.output * price.output +
        row.tokens.cacheRead * price.cacheRead +
        row.tokens.cacheWrite * price.cacheWrite +
        row.tokens.thinking * price.thinking;
      totals.cost += cost;
      totals.currency = price.currency;
    } else {
      unpriced += 1;
    }
    totals.calls += row.calls;
    addTokens(totals.tokens, row.tokens);
    return { provider: row.provider, model: row.model, calls: row.calls, tokens: row.tokens, cost };
  });
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return { sinceRestart: true, rows, totals, unpriced };
}

/**
 * `GET /` on the returned sub-app answers with the calling session's own
 * tenant-scoped workspace usage, nothing else. No secrets, no writes --
 * mounted at `/api/tenants/:tenantId/spend` by the caller (`index.ts`), it
 * relies on the same tenant/session middleware `createApp` already applies
 * to every other `TenantEnv` mount there.
 */
export function createSpendApi(db: AnyDb, store: SpendStore): Hono<TenantEnv> {
  const spendApi = new Hono<TenantEnv>();
  spendApi.get("/", async (c) => {
    const tenantId = (c.get("tenant") as { id: string }).id;
    const summary = await summarize(db, tenantId, store);
    return c.json({ data: summary });
  });
  return spendApi;
}
