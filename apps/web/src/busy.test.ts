import { describe, expect, test } from "bun:test";
import {
  IDLE,
  beginBusy,
  busyCount,
  indicatorVisible,
  nextDeadline,
  stepIndicator,
  subscribeBusy,
  trackBusy,
  type IndicatorState,
} from "./busy.ts";

const timing = { showAfterMs: 500, lingerMs: 600 };

describe("the busy count", () => {
  test("counts each registration until it is released, and a release is idempotent", () => {
    expect(busyCount()).toBe(0);
    const releaseA = beginBusy();
    const releaseB = beginBusy();
    expect(busyCount()).toBe(2);
    releaseA();
    releaseA();
    expect(busyCount()).toBe(1);
    releaseB();
    expect(busyCount()).toBe(0);
  });

  test("a tracked promise is released whether it resolves or rejects", async () => {
    await expect(trackBusy(Promise.resolve("ok"))).resolves.toBe("ok");
    expect(busyCount()).toBe(0);
    await expect(trackBusy(Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(busyCount()).toBe(0);
  });

  test("subscribers hear every change, and stop hearing once unsubscribed", () => {
    const heard: number[] = [];
    const unsubscribe = subscribeBusy((count) => heard.push(count));
    const release = beginBusy();
    release();
    unsubscribe();
    beginBusy()();
    expect(heard).toEqual([1, 0]);
  });
});

// The product rule: an action longer than half a second must say the app is
// busy, and one shorter than that must not flash an indicator on and off.
describe("when the indicator shows", () => {
  test("work shorter than the grace period never shows", () => {
    let state: IndicatorState = stepIndicator(IDLE, 1, 1_000, timing);
    expect(state.phase).toBe("arming");
    expect(indicatorVisible(state)).toBe(false);
    state = stepIndicator(state, 0, 1_200, timing);
    expect(state).toBe(IDLE);
  });

  test("continuous work shows once the grace period has passed, counting from when it began", () => {
    let state: IndicatorState = stepIndicator(IDLE, 1, 1_000, timing);
    expect(nextDeadline(state, 1_100, timing)).toBe(400);
    state = stepIndicator(state, 1, 1_499, timing);
    expect(state.phase).toBe("arming");
    state = stepIndicator(state, 1, 1_500, timing);
    expect(state).toEqual({ phase: "shown", since: 1_000 });
    expect(indicatorVisible(state)).toBe(true);
    expect(nextDeadline(state, 1_500, timing)).toBeNull();
  });

  test("a gap between chained requests shorter than the linger keeps it up", () => {
    let state: IndicatorState = { phase: "shown", since: 1_000 };
    state = stepIndicator(state, 0, 2_000, timing);
    expect(state).toEqual({ phase: "lingering", since: 1_000, idleAt: 2_000 });
    expect(indicatorVisible(state)).toBe(true);
    expect(nextDeadline(state, 2_100, timing)).toBe(500);
    state = stepIndicator(state, 1, 2_300, timing);
    expect(state).toEqual({ phase: "shown", since: 1_000 });
  });

  test("it goes down once the count has stayed at zero for the linger", () => {
    let state: IndicatorState = { phase: "lingering", since: 1_000, idleAt: 2_000 };
    state = stepIndicator(state, 0, 2_599, timing);
    expect(state.phase).toBe("lingering");
    state = stepIndicator(state, 0, 2_600, timing);
    expect(state).toBe(IDLE);
  });
});
