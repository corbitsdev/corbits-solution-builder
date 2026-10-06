/**
 * What a build attempt spent, in the worker's own numbers.
 *
 * A coding agent that spawns agents of its own reports only its own turns
 * through its lifecycle hook; the agents it spawned are where most of the
 * tokens go (fifteen times as many, in one eight-hour build). The worker's
 * own log has every inference call it and its agents made, each with a
 * timestamp and the four token counts. This module reads that log, keeps
 * the calls in memory as it grows, and sums the ones that fell inside an
 * attempt's window: from its start to its end, or to now while it runs.
 *
 * Counted, never priced here: the counts are the worker's, a price is a
 * provider's, and the page says which price it applied.
 */
import { open, stat } from "node:fs/promises";

export type TokenCounts = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/** One inference call the worker's log reports. */
export type UsageCall = TokenCounts & { readonly at: number };

export type AttemptUsage = TokenCounts & {
  readonly calls: number;
  /** Where the counts came from, said for the page: the worker's log, read over the attempt's window. */
  readonly source: string;
  /** The models the worker's own turns name, each once; what a price is looked up for. */
  readonly models: readonly string[];
};

/** Reads one line of a worker's log as a call, or null when the line is not one. */
export type UsageLineParser = (line: string) => UsageCall | null;

const CORBITS_USAGE = /^Inference usage:((?:\s+\w+=\d+)+)\s*$/;

/**
 * Corbits Code logs each call as `{"timestamp":…,"message":"Inference usage:
 * input=2 output=206 cacheRead=10834 cacheWrite=1543"}`, one JSON object per
 * line. Anything else on the line, or a line that is not JSON, is not a call.
 */
export const parseCorbitsUsageLine: UsageLineParser = (line) => {
  if (!line.includes("Inference usage")) return null;
  let record: { timestamp?: unknown; message?: unknown };
  try {
    record = JSON.parse(line) as { timestamp?: unknown; message?: unknown };
  } catch {
    return null;
  }
  if (typeof record.message !== "string" || typeof record.timestamp !== "string") return null;
  const match = CORBITS_USAGE.exec(record.message);
  if (!match) return null;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at)) return null;
  const counts: Record<string, number> = {};
  for (const part of (match[1] ?? "").trim().split(/\s+/)) {
    const [name, value] = part.split("=");
    if (name && value) counts[name] = Number(value);
  }
  return { at, input: counts.input ?? 0, output: counts.output ?? 0, cacheRead: counts.cacheRead ?? 0, cacheWrite: counts.cacheWrite ?? 0 };
};

/** The model a worker's turn report names, from `assistantTurn.model`; null for any other line. */
export function parseTurnModel(line: string): string | null {
  if (!line.includes('"model"')) return null;
  try {
    const record = JSON.parse(line) as { assistantTurn?: { model?: unknown } };
    return typeof record.assistantTurn?.model === "string" ? record.assistantTurn.model : null;
  } catch {
    return null;
  }
}

type Index<T> = { offset: number; partial: string; records: T[] };

const indexes = new Map<string, Index<unknown>>();

/**
 * The records a line-per-record file holds, read incrementally: each call
 * reads what the file gained since the last, and a file that shrank
 * (rotated, or started over) is read again from its start. A file that is
 * not there is no records. Lines the parser returns null for are dropped.
 */
export async function indexedRecords<T>(path: string, parse: (line: string) => T | null): Promise<readonly T[]> {
  let index = indexes.get(path) as Index<T> | undefined;
  if (!index) {
    index = { offset: 0, partial: "", records: [] };
    indexes.set(path, index as Index<unknown>);
  }
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return index.records;
  }
  if (size < index.offset) {
    index.offset = 0;
    index.partial = "";
    index.records = [];
  }
  if (size === index.offset) return index.records;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - index.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, index.offset);
    index.offset += bytesRead;
    index.partial += buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = index.partial.split("\n");
  index.partial = lines.pop() ?? "";
  for (const line of lines) {
    const record = parse(line);
    if (record !== null) index.records.push(record);
  }
  return index.records;
}

/** The calls a worker's usage log holds, read incrementally. */
export function usageCalls(path: string, parse: UsageLineParser): Promise<readonly UsageCall[]> {
  return indexedRecords(path, parse);
}

/** The models a turn log names, each once, in the order first seen. */
export async function turnLogModels(path: string): Promise<string[]> {
  return [...new Set(await indexedRecords(path, parseTurnModel))];
}

/** For tests: forget what was read. */
export function resetUsageIndexes(): void {
  indexes.clear();
}

/** The calls that fell inside the window, summed. `to` null is "still running": up to now. */
export function sumUsage(calls: readonly UsageCall[], window: { readonly from: string; readonly to: string | null }, source: string, models: readonly string[] = []): AttemptUsage {
  const from = Date.parse(window.from);
  const to = window.to ? Date.parse(window.to) : Number.POSITIVE_INFINITY;
  let total = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const call of calls) {
    if (call.at < from || call.at > to) continue;
    total = { calls: total.calls + 1, input: total.input + call.input, output: total.output + call.output, cacheRead: total.cacheRead + call.cacheRead, cacheWrite: total.cacheWrite + call.cacheWrite };
  }
  return { ...total, source, models };
}
