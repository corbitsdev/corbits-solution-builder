/**
 * What a build attempt has cost so far, in the worker's own counts and at
 * a published price (#785).
 *
 * The counts are the host's: every inference call the worker's log holds
 * over the attempt's window. The price is a provider's list price for the
 * model the worker's own turns name, kept here because no price is on file
 * in the hub by default. The figure is an estimate and says so: the rates
 * it applied are in the tooltip, so a reader can judge it.
 */
import type { BuildAttempt } from "../../client.ts";
import { formatMoney, formatTokens } from "../../project-usage.ts";

export type BuildUsage = NonNullable<BuildAttempt["usage"]>;

/** USD per million tokens. */
export type ListPrice = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };

/**
 * Anthropic's first-party list prices (checked 2026-09-25). Input and
 * output are published per model; cache reads and writes are the published
 * rate where one is stated, else the standard tenth and five-fourths of
 * the input price.
 */
export const LIST_PRICES: Readonly<Record<string, ListPrice>> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const MILLION = 1_000_000;

/** The list price for a model id, with or without a date suffix; null when none is on file. */
export function listPrice(model: string): ListPrice | null {
  const exact = LIST_PRICES[model];
  if (exact) return exact;
  const undated = model.replace(/-\d{8}$/, "");
  return LIST_PRICES[undated] ?? null;
}

export type CostEstimate = { readonly amount: number; readonly model: string; readonly price: ListPrice };

/**
 * The attempt's cost at the list price of the first model the worker's
 * turns name that has one. Every token is priced at that model's rate,
 * the agents the worker spawned included, which is what the tooltip says.
 */
export function estimateCost(usage: BuildUsage): CostEstimate | null {
  for (const model of usage.models) {
    const price = listPrice(model);
    if (!price) continue;
    const amount = (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / MILLION;
    return { amount, model, price };
  }
  return null;
}

const count = (n: number): string => n.toLocaleString();

/**
 * How long an attempt has run, readable at any length: minutes and seconds
 * under an hour, hours and minutes from then on. "481:37" is eight hours,
 * which nobody reads off it.
 */
export function elapsedLabel(seconds: number): string {
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * The header's spend: tokens out and in, and the estimate when there is
 * one. The title carries the breakdown, the rates and where the counts
 * came from.
 */
export function spendLine(usage: BuildUsage): { text: string; title: string } {
  const read = usage.input + usage.cacheRead + usage.cacheWrite;
  const estimate = estimateCost(usage);
  const tokens = `${formatTokens(usage.output)} tokens out, ${formatTokens(read)} in`;
  const text = estimate ? `${tokens} · ≈ ${formatMoney(estimate.amount, "USD")}` : usage.models.length > 0 ? `${tokens} (${usage.models[0]}, no list price on file)` : tokens;
  const lines = [
    `${count(usage.calls)} inference call${usage.calls === 1 ? "" : "s"}: ${count(usage.output)} tokens out; ${count(usage.input)} in, ${count(usage.cacheRead)} read from cache, ${count(usage.cacheWrite)} written to cache.`,
    `Counted from ${usage.source}.`,
  ];
  if (estimate) {
    const rate = estimate.price;
    lines.push(
      `≈ ${formatMoney(estimate.amount, "USD")} at ${estimate.model}'s list price: $${String(rate.input)} in, $${String(rate.output)} out, $${String(rate.cacheRead)} cache read, $${String(rate.cacheWrite)} cache write, per million tokens. Every call is priced at that rate, whichever model made it.`,
    );
  } else if (usage.models.length > 0) {
    lines.push(`No list price on file for ${usage.models.join(", ")}, so no cost is estimated.`);
  }
  return { text, title: lines.join("\n") };
}
