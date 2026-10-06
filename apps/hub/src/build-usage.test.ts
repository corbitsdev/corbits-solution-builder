import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedRecords, parseCorbitsUsageLine, parseTurnModel, resetUsageIndexes, sumUsage, turnLogModels, usageCalls } from "./build-usage.ts";

const line = (timestamp: string, message: string) => JSON.stringify({ timestamp, level: "info", category: "interchange.reactor", message, properties: {} });

describe("parseCorbitsUsageLine", () => {
  test("reads a Corbits Code usage line as a call with its four counts", () => {
    expect(parseCorbitsUsageLine(line("2026-10-06T01:08:14.450Z", "Inference usage: input=2 output=206 cacheRead=10834 cacheWrite=1543"))).toEqual({
      at: Date.parse("2026-10-06T01:08:14.450Z"),
      input: 2,
      output: 206,
      cacheRead: 10834,
      cacheWrite: 1543,
    });
  });

  test("anything else is not a call: another message, a line that is not JSON, a bad timestamp", () => {
    expect(parseCorbitsUsageLine(line("2026-10-06T01:08:14.450Z", "authz deny resource=tool:bash"))).toBeNull();
    expect(parseCorbitsUsageLine("Inference usage: input=2 output=3")).toBeNull();
    expect(parseCorbitsUsageLine(line("yesterday", "Inference usage: input=2 output=206 cacheRead=1 cacheWrite=1"))).toBeNull();
    expect(parseCorbitsUsageLine("")).toBeNull();
  });
});

describe("parseTurnModel", () => {
  test("names the model of a turn report, and nothing for other lines", () => {
    expect(parseTurnModel(JSON.stringify({ turnIndex: 0, assistantTurn: { role: "assistant", model: "claude-fable-5" }, usage: {} }))).toBe("claude-fable-5");
    expect(parseTurnModel(JSON.stringify({ turnIndex: 0 }))).toBeNull();
    expect(parseTurnModel("not json \"model\"")).toBeNull();
  });
});

describe("indexedRecords", () => {
  let root: string;
  afterEach(async () => {
    resetUsageIndexes();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("reads what the file gained since the last call, keeps a split line for the next, and starts over when the file shrinks", async () => {
    root = await mkdtemp(join(tmpdir(), "usage-"));
    const path = join(root, "corbits.log");
    await writeFile(path, `${line("2026-10-05T17:10:00Z", "Inference usage: input=1 output=10 cacheRead=100 cacheWrite=1000")}\n`);
    expect((await usageCalls(path, parseCorbitsUsageLine)).map((call) => call.output)).toEqual([10]);
    // Half a line lands, then the rest.
    const next = line("2026-10-05T17:11:00Z", "Inference usage: input=2 output=20 cacheRead=200 cacheWrite=2000");
    await appendFile(path, next.slice(0, 40));
    expect((await usageCalls(path, parseCorbitsUsageLine)).map((call) => call.output)).toEqual([10]);
    await appendFile(path, `${next.slice(40)}\n`);
    expect((await usageCalls(path, parseCorbitsUsageLine)).map((call) => call.output)).toEqual([10, 20]);
    // Nothing new: the same records, no read.
    expect((await usageCalls(path, parseCorbitsUsageLine)).map((call) => call.output)).toEqual([10, 20]);
    // Rotated: smaller than what was read, so read again from the start.
    await writeFile(path, `${line("2026-10-05T18:00:00Z", "Inference usage: input=3 output=30 cacheRead=300 cacheWrite=3000")}\n`);
    expect((await usageCalls(path, parseCorbitsUsageLine)).map((call) => call.output)).toEqual([30]);
    // A file that is not there is no records.
    expect(await indexedRecords(join(root, "missing.log"), parseCorbitsUsageLine)).toEqual([]);
  });

  test("turnLogModels names each model once", async () => {
    root = await mkdtemp(join(tmpdir(), "usage-"));
    const path = join(root, "1.turns.jsonl");
    const turn = (model: string) => JSON.stringify({ turnIndex: 0, assistantTurn: { model } });
    await writeFile(path, `${turn("claude-fable-5")}\n${turn("claude-fable-5")}\n${turn("claude-haiku-4-5")}\n`);
    expect(await turnLogModels(path)).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
  });
});

describe("sumUsage", () => {
  const calls = [
    { at: Date.parse("2026-10-05T17:00:00Z"), input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    { at: Date.parse("2026-10-05T17:30:00Z"), input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    { at: Date.parse("2026-10-05T18:30:00Z"), input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
    { at: Date.parse("2026-10-05T19:00:00Z"), input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000 },
  ];

  test("sums the calls inside the attempt's window, start to end", () => {
    expect(sumUsage(calls, { from: "2026-10-05T17:09:15Z", to: "2026-10-05T18:45:00Z" }, "the log", ["claude-fable-5"])).toEqual({
      calls: 2,
      input: 110,
      output: 220,
      cacheRead: 330,
      cacheWrite: 440,
      source: "the log",
      models: ["claude-fable-5"],
    });
  });

  test("an attempt still running counts up to now", () => {
    expect(sumUsage(calls, { from: "2026-10-05T18:00:00Z", to: null }, "the log").calls).toBe(2);
    expect(sumUsage([], { from: "2026-10-05T18:00:00Z", to: null }, "the log")).toEqual({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "the log", models: [] });
  });
});
