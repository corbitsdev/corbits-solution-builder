/**
 * What a project has spent on inference, with which provider.
 *
 * Four things run a model on a project's behalf: the stage rounds the
 * platform runs (read from the run's own events in `round-spend.ts`), the
 * host's own calls, the deck illustrations, and the build worker. Each is
 * recorded here as one usage record on the project's own ledger session, in
 * the provider's and model's own names, with the token counts the source
 * actually reported — and `tokens: null` where it reported
 * none, because a call that happened and was not counted is not a call that
 * cost nothing.
 *
 * Money comes from the platform's pricing table, per offering and per token
 * kind, where a row exists for the model; elsewhere the usage is shown as
 * tokens and marked unpriced. A total is only ever over what has a price.
 */
import { catalog, hubList, tenantPath, type HubModel, type HubOffering } from "./hub-client.js";
import { recordUsage, usageRecords, type UsageRecord } from "./engine-ledger.js";
import { listProjectRecords } from "./installer-bridge.js";
import { newId } from "./ids.js";

export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number };

/** A stage round's call, attributed to the project its run belongs to. */
export async function recordRoundUsage(args: {
  projectId: string;
  runId: string;
  provider: string;
  model: string;
  tokens: TokenCounts | null;
}): Promise<void> {
  await recordUsage(args.projectId, {
    id: newId.event(),
    at: new Date().toISOString(),
    source: "round",
    purpose: "stage round",
    provider: args.provider,
    model: args.model,
    tokens: args.tokens,
    images: 0,
    calls: 1,
    runId: args.runId,
  });
}

/** A call the host made itself, with what the provider said it used. */
export async function recordHostUsage(args: {
  projectId: string;
  purpose: string;
  provider: string;
  model: string;
  tokens: TokenCounts | null;
}): Promise<void> {
  await recordUsage(args.projectId, {
    id: newId.event(),
    at: new Date().toISOString(),
    source: "host",
    purpose: args.purpose,
    provider: args.provider,
    model: args.model,
    tokens: args.tokens,
    images: 0,
    calls: 1,
    runId: null,
  });
}

/** Pictures drawn for a deck: counted, since image models price per image. */
export async function recordIllustrations(args: { projectId: string; provider: string; model: string; images: number }): Promise<void> {
  if (args.images === 0) return;
  await recordUsage(args.projectId, {
    id: newId.event(),
    at: new Date().toISOString(),
    source: "illustration",
    purpose: "deck illustrations",
    provider: args.provider,
    model: args.model,
    tokens: null,
    images: args.images,
    calls: args.images,
    runId: null,
  });
}

/**
 * The build worker's usage, summed from its own turn reports: one record per
 * provider and model it used during the attempt.
 */
export async function recordWorkerUsage(args: { projectId: string; runId: string; turnLog: string }): Promise<number> {
  let text: string;
  try {
    text = await Bun.file(args.turnLog).text();
  } catch {
    return 0;
  }
  const sums = new Map<string, { provider: string; model: string; tokens: TokenCounts; calls: number }>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let report: { usage?: Partial<TokenCounts>; source?: { provider?: string; model?: string } };
    try {
      report = JSON.parse(line) as typeof report;
    } catch {
      continue;
    }
    const provider = report.source?.provider ?? "unknown";
    const model = report.source?.model ?? "unknown";
    const key = `${provider} ${model}`;
    const entry = sums.get(key) ?? { provider, model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, calls: 0 };
    entry.calls += 1;
    for (const kind of ["input", "output", "cacheRead", "cacheWrite", "thinking"] as const) {
      entry.tokens[kind] += Number(report.usage?.[kind] ?? 0);
    }
    sums.set(key, entry);
  }
  for (const entry of sums.values()) {
    await recordUsage(args.projectId, {
      id: newId.event(),
      at: new Date().toISOString(),
      source: "worker",
      purpose: "build attempt",
      provider: entry.provider,
      model: entry.model,
      tokens: entry.tokens,
      images: 0,
      calls: entry.calls,
      runId: args.runId,
    });
  }
  return sums.size;
}

// --- Pricing ------------------------------------------------------------------

/** A price per token kind in USD, from the platform's pricing table. */
export type ModelPrice = {
  currency: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  perImage: number;
};

type PricingRow = {
  currency?: string;
  effectiveFrom?: string;
  inputTokenPrice?: string | null;
  outputTokenPrice?: string | null;
  cacheReadTokenPrice?: string | null;
  cacheWriteTokenPrice?: string | null;
  thinkingTokenPrice?: string | null;
  perImageFee?: string | null;
};

const number = (value: string | null | undefined): number => (value ? Number(value) || 0 : 0);

/**
 * The current price for a model by name, or null when the platform has no
 * row for it. Read once per summary: the catalog is small and the table is
 * append-only, so the newest effective row is the one.
 */
export async function pricesByModel(): Promise<Map<string, ModelPrice>> {
  const prices = new Map<string, ModelPrice>();
  let models: HubModel[];
  let offerings: HubOffering[];
  try {
    [models, offerings] = await Promise.all([catalog.models(), catalog.offerings()]);
  } catch {
    return prices;
  }
  const names = new Map(models.map((model) => [model.id, model.canonicalName]));
  for (const offering of offerings) {
    const name = names.get(offering.modelId);
    if (!name || prices.has(name)) continue;
    let rows: PricingRow[];
    try {
      rows = await hubList<PricingRow>(tenantPath(`/catalog/offerings/${offering.id}/pricing`));
    } catch {
      continue;
    }
    const now = new Date().toISOString();
    const current = rows
      .filter((row) => !row.effectiveFrom || row.effectiveFrom <= now)
      .sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""))[0];
    if (!current) continue;
    prices.set(name, {
      currency: current.currency ?? "USD",
      input: number(current.inputTokenPrice),
      output: number(current.outputTokenPrice),
      cacheRead: number(current.cacheReadTokenPrice),
      cacheWrite: number(current.cacheWriteTokenPrice),
      thinking: number(current.thinkingTokenPrice),
      perImage: number(current.perImageFee),
    });
  }
  return prices;
}

// --- Summaries ----------------------------------------------------------------

export type SpendRow = {
  provider: string;
  model: string;
  calls: number;
  images: number;
  tokens: TokenCounts;
  /** Calls that reported no token counts: happened, cost something, not counted. */
  uncounted: number;
  /** In the price's currency, or null when the model has no price here. */
  cost: number | null;
  currency: string | null;
};

export type SpendSummary = {
  rows: SpendRow[];
  totals: { calls: number; images: number; tokens: TokenCounts; uncounted: number; cost: number; currency: string };
  /** Rows whose usage has no price; their tokens are not in the total. */
  unpriced: number;
};

function addTokens(into: TokenCounts, from: TokenCounts | null): void {
  if (!from) return;
  for (const kind of ["input", "output", "cacheRead", "cacheWrite", "thinking"] as const) into[kind] += from[kind] ?? 0;
}

function summarize(records: UsageRecord[], prices: Map<string, ModelPrice>): SpendSummary {
  const rows = new Map<string, SpendRow>();
  for (const record of records) {
    const key = `${record.provider} ${record.model}`;
    const row =
      rows.get(key) ??
      { provider: record.provider, model: record.model, calls: 0, images: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, uncounted: 0, cost: null, currency: null };
    row.calls += record.calls;
    row.images += record.images;
    if (record.tokens) addTokens(row.tokens, record.tokens);
    else if (record.images === 0) row.uncounted += record.calls;
    rows.set(key, row);
  }
  const totals: SpendSummary["totals"] = { calls: 0, images: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, uncounted: 0, cost: 0, currency: "USD" };
  let unpriced = 0;
  for (const row of rows.values()) {
    const price = prices.get(row.model);
    if (price) {
      row.currency = price.currency;
      row.cost =
        row.tokens.input * price.input +
        row.tokens.output * price.output +
        row.tokens.cacheRead * price.cacheRead +
        row.tokens.cacheWrite * price.cacheWrite +
        row.tokens.thinking * price.thinking +
        row.images * price.perImage;
      totals.cost += row.cost;
      totals.currency = price.currency;
    } else {
      unpriced += 1;
    }
    totals.calls += row.calls;
    totals.images += row.images;
    totals.uncounted += row.uncounted;
    addTokens(totals.tokens, row.tokens);
  }
  return { rows: [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)), totals, unpriced };
}

/** One project's spend, by provider and model. */
export async function projectSpend(projectId: string, prices?: Map<string, ModelPrice>): Promise<SpendSummary> {
  return summarize(await usageRecords(projectId), prices ?? (await pricesByModel()));
}

export type WorkspaceSpend = {
  totals: SpendSummary["totals"];
  unpriced: number;
  byProvider: { provider: string; calls: number; images: number; tokens: TokenCounts; cost: number | null }[];
  projects: { id: string; title: string; archivedAt: string | null; totals: SpendSummary["totals"]; unpriced: number }[];
};

/** Every project's spend, and the whole. */
export async function workspaceSpend(): Promise<WorkspaceSpend> {
  const prices = await pricesByModel();
  const projects: WorkspaceSpend["projects"] = [];
  const byProvider = new Map<string, WorkspaceSpend["byProvider"][number]>();
  const totals: SpendSummary["totals"] = { calls: 0, images: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, uncounted: 0, cost: 0, currency: "USD" };
  let unpriced = 0;
  for (const record of await listProjectRecords()) {
    const summary = await projectSpend(record.id, prices);
    projects.push({ id: record.id, title: record.title, archivedAt: record.archivedAt?.toISOString() ?? null, totals: summary.totals, unpriced: summary.unpriced });
    totals.calls += summary.totals.calls;
    totals.images += summary.totals.images;
    totals.uncounted += summary.totals.uncounted;
    totals.cost += summary.totals.cost;
    addTokens(totals.tokens, summary.totals.tokens);
    unpriced += summary.unpriced;
    for (const row of summary.rows) {
      const entry = byProvider.get(row.provider) ?? { provider: row.provider, calls: 0, images: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, cost: null };
      entry.calls += row.calls;
      entry.images += row.images;
      addTokens(entry.tokens, row.tokens);
      if (row.cost !== null) entry.cost = (entry.cost ?? 0) + row.cost;
      byProvider.set(row.provider, entry);
    }
  }
  return { totals, unpriced, byProvider: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)), projects };
}
