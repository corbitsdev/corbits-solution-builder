import { describe, expect, test } from "bun:test";
import { elapsedLabel, estimateCost, listPrice, spendLine, type BuildUsage } from "./build-spend.ts";

// Attempt 1 of the Inteva build, as the host counted it: 3,266 calls over eight hours.
const attempt: BuildUsage = {
  calls: 3266,
  input: 21163,
  output: 2150153,
  cacheRead: 209784234,
  cacheWrite: 8881334,
  source: "every Corbits Code inference call on this computer while the attempt ran, the agents the worker spawned included",
  models: ["claude-fable-5"],
};

describe("listPrice", () => {
  test("knows the current models, with or without a date suffix, and nothing else", () => {
    expect(listPrice("claude-fable-5")?.output).toBe(50);
    expect(listPrice("claude-opus-5-5-20260401")?.input).toBe(4);
    expect(listPrice("gpt-5")).toBeNull();
  });
});

describe("estimateCost", () => {
  test("prices every count at the first named model's list rate", () => {
    const estimate = estimateCost(attempt);
    expect(estimate?.model).toBe("claude-fable-5");
    // 21,163 × $10 + 2,150,153 × $50 + 209,784,234 × $1 + 8,881,334 × $12.5, per million.
    expect(estimate?.amount).toBeCloseTo(0.21163 + 107.50765 + 209.784234 + 111.016675, 3);
  });

  test("skips a model without a price for one with, and is null when none has one", () => {
    expect(estimateCost({ ...attempt, models: ["gpt-5", "claude-haiku-4-5"] })?.model).toBe("claude-haiku-4-5");
    expect(estimateCost({ ...attempt, models: ["gpt-5"] })).toBeNull();
    expect(estimateCost({ ...attempt, models: [] })).toBeNull();
  });
});

describe("spendLine", () => {
  test("says tokens out and in and the estimate, with the breakdown and rates in the title", () => {
    const line = spendLine(attempt);
    expect(line.text).toBe("2.15M tokens out, 218.69M in · ≈ $428.52");
    expect(line.title).toContain("3,266 inference calls: 2,150,153 tokens out; 21,163 in, 209,784,234 read from cache, 8,881,334 written to cache.");
    expect(line.title).toContain("Counted from every Corbits Code inference call on this computer");
    expect(line.title).toContain("≈ $428.52 at claude-fable-5's list price: $10 in, $50 out, $1 cache read, $12.5 cache write, per million tokens.");
  });

  test("without a price it says so instead of a figure", () => {
    const line = spendLine({ ...attempt, models: ["gpt-5"] });
    expect(line.text).toBe("2.15M tokens out, 218.69M in (gpt-5, no list price on file)");
    expect(line.title).toContain("No list price on file for gpt-5");
    expect(spendLine({ ...attempt, models: [] }).text).toBe("2.15M tokens out, 218.69M in");
  });

  test("a single call is singular", () => {
    expect(spendLine({ calls: 1, input: 5, output: 7, cacheRead: 0, cacheWrite: 0, source: "the log", models: [] }).title).toContain("1 inference call: 7 tokens out; 5 in");
  });
});

describe("elapsedLabel", () => {
  test("minutes and seconds under an hour, hours and minutes from then on", () => {
    expect(elapsedLabel(0)).toBe("0:00");
    expect(elapsedLabel(65)).toBe("1:05");
    expect(elapsedLabel(3599)).toBe("59:59");
    expect(elapsedLabel(3600)).toBe("1h 00m");
    expect(elapsedLabel(481 * 60 + 37)).toBe("8h 01m");
  });
});
