import { describe, expect, test } from "bun:test";
import { newestRun, runStateOf, specialistBusy } from "./specialist-run-state.ts";

const ev = (seq: number, type: string, body: Record<string, unknown> = {}) => ({ seq, type, body: { at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`, ...body } });
const runStateFromEvents = (events: Parameters<typeof runStateOf>[0]) => runStateOf(events).state;

describe("runStateFromEvents", () => {
  test("a step that started and has not parked is working", () => {
    expect(runStateFromEvents([ev(1, "RunStarted"), ev(2, "StepStarted", { stepId: "run" })])).toBe("working");
  });

  test("a step parked for its next mail is idle, and a delivered mail makes it working again", () => {
    const parked = [ev(1, "RunStarted"), ev(2, "StepStarted"), ev(3, "SignalAwaited", { stepId: "run", parkKind: "input" })];
    expect(runStateFromEvents(parked)).toBe("idle");
    expect(runStateFromEvents([...parked, ev(4, "SignalReceived", { signalName: "s" })])).toBe("working");
    expect(runStateFromEvents([...parked, ev(4, "SignalReceived"), ev(5, "SignalAwaited")])).toBe("idle");
  });

  test("order of the array does not matter; the highest seq decides", () => {
    expect(runStateFromEvents([ev(5, "SignalAwaited"), ev(2, "StepStarted"), ev(6, "SignalReceived"), ev(1, "RunStarted")])).toBe("working");
  });

  test("an ended run is ended, and a log with nothing to say is unknown", () => {
    expect(runStateFromEvents([ev(1, "RunStarted"), ev(2, "StepStarted"), ev(3, "RunFailed")])).toBe("ended");
    expect(runStateOf([ev(1, "RunStarted"), ev(2, "StepStarted"), ev(3, "SignalAwaited")]).at).toBe("2026-01-01T00:00:03.000Z");
    expect(runStateFromEvents([ev(1, "RunStarted")])).toBe("unknown");
    expect(runStateFromEvents([])).toBe("unknown");
  });
});

describe("specialistBusy", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const T1 = "2026-01-01T00:00:10.000Z";
  const T2 = "2026-01-01T00:00:20.000Z";
  test("a working run is busy whatever the mailbox says", () => {
    expect(specialistBusy({ state: "working", at: T0 }, null)).toBe(true);
  });

  test("a turn sent after the run last parked is still in flight; one sent before it was answered or dropped", () => {
    expect(specialistBusy({ state: "idle", at: T1 }, T2)).toBe(true);
    expect(specialistBusy({ state: "idle", at: T1 }, T0)).toBe(false);
    expect(specialistBusy({ state: "ended", at: T1 }, T0)).toBe(false);
  });

  test("no turn pending is idle, and a run that cannot be read leaves it to the mailbox", () => {
    expect(specialistBusy({ state: "idle", at: T1 }, null)).toBe(false);
    expect(specialistBusy({ state: "unknown", at: null }, T0)).toBe(true);
    expect(specialistBusy({ state: "unknown", at: null }, null)).toBe(false);
  });
});

describe("newestRun", () => {
  test("a live run beats an ended one, and among live runs the newest word wins, whatever the order", () => {
    const old = { state: "idle" as const, at: "2026-01-01T00:00:10.000Z" };
    const fresh = { state: "working" as const, at: "2026-01-01T00:00:20.000Z" };
    const ended = { state: "ended" as const, at: "2026-01-01T00:00:30.000Z" };
    expect(newestRun([old, fresh, ended])).toBe(fresh);
    expect(newestRun([ended, fresh, old])).toBe(fresh);
    expect(newestRun([ended])).toBe(ended);
    expect(newestRun([{ state: "unknown", at: null }])).toEqual({ state: "unknown", at: null });
    expect(newestRun([])).toEqual({ state: "unknown", at: null });
  });
});
