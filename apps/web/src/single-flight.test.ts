import { describe, expect, test } from "bun:test";
import { singleFlight, withinBound } from "./single-flight.ts";

describe("singleFlight", () => {
  test("concurrent calls share one run; a later call after it settles runs again", async () => {
    let runs = 0;
    let release: (value: number) => void = () => undefined;
    const guarded = singleFlight(() => {
      runs += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    });
    const first = guarded();
    const second = guarded();
    expect(second).toBe(first);
    release(7);
    expect(await first).toBe(7);
    expect(runs).toBe(1);
    const third = guarded();
    expect(runs).toBe(2);
    release(8);
    expect(await third).toBe(8);
  });

  test("a failure releases the flight too", async () => {
    let runs = 0;
    const guarded = singleFlight(async () => {
      runs += 1;
      throw new Error("no");
    });
    await expect(guarded()).rejects.toThrow("no");
    await expect(guarded()).rejects.toThrow("no");
    expect(runs).toBe(2);
  });
});

describe("withinBound", () => {
  test("says done when the work settles first, timed out when the bound passes first, and never throws", async () => {
    expect(await withinBound(Promise.resolve(1), 1000, () => new Promise(() => undefined))).toBe("done");
    expect(await withinBound(Promise.reject(new Error("x")), 1000, () => new Promise(() => undefined))).toBe("done");
    expect(await withinBound(new Promise(() => undefined), 10, async () => undefined)).toBe("timed_out");
  });
});
