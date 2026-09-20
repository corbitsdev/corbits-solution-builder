import { describe, expect, test } from "bun:test";
import {
  nextBackoffMs,
  shouldFallbackRefetch,
  shouldRefetch,
  subscribeMailbox,
  type EventSourceLike,
} from "./mailbox-events.ts";

describe("shouldRefetch", () => {
  test("refetches on a create in INBOX", () => {
    expect(shouldRefetch({ id: "INBOX:12", op: "create" })).toBe(true);
  });

  test("ignores other folders", () => {
    expect(shouldRefetch({ id: "Sent:12", op: "create" })).toBe(false);
  });

  test("ignores non-create ops", () => {
    for (const op of ["mark_read", "mark_unread", "archive", "trash", "restore"] as const) {
      expect(shouldRefetch({ id: "INBOX:12", op })).toBe(false);
    }
  });

  test("ignores an event with no op", () => {
    expect(shouldRefetch({ id: "INBOX:12" })).toBe(false);
  });
});

describe("shouldFallbackRefetch", () => {
  test("refetches when the stream is closed", () => {
    expect(shouldFallbackRefetch({ open: false, msSinceLastLoad: 0 })).toBe(true);
  });

  test("skips when open and recently loaded", () => {
    expect(shouldFallbackRefetch({ open: true, msSinceLastLoad: 20_000 })).toBe(false);
  });

  test("refetches when open but the 60s ceiling has passed", () => {
    expect(shouldFallbackRefetch({ open: true, msSinceLastLoad: 60_000 })).toBe(true);
  });
});

describe("nextBackoffMs", () => {
  test("doubles from a 1s base", () => {
    expect(nextBackoffMs(0)).toBe(1_000);
    expect(nextBackoffMs(1)).toBe(2_000);
    expect(nextBackoffMs(2)).toBe(4_000);
  });

  test("caps at 30s", () => {
    expect(nextBackoffMs(10)).toBe(30_000);
  });
});

type Listener = (event: { data: string }) => void;

class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, Listener[]>();
  closed = false;

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  close(): void {
    this.closed = true;
  }
}

function fakeDeps() {
  const sources: FakeEventSource[] = [];
  const timers: Array<{ callback: () => void; ms: number }> = [];
  return {
    sources,
    timers,
    deps: {
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      setTimeout: (callback: () => void, ms: number) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimeout: () => {},
    },
  };
}

describe("subscribeMailbox", () => {
  test("nudges onNudge for a create event in INBOX", () => {
    const { sources, deps } = fakeDeps();
    const nudges: string[] = [];
    subscribeMailbox("tnt_1", (event) => nudges.push(event.id), deps);
    sources[0]!.emit("mailbox", JSON.stringify({ id: "INBOX:1", op: "create" }));
    expect(nudges).toEqual(["INBOX:1"]);
  });

  test("does not nudge for a non-refetch event", () => {
    const { sources, deps } = fakeDeps();
    const nudges: string[] = [];
    subscribeMailbox("tnt_1", (event) => nudges.push(event.id), deps);
    sources[0]!.emit("mailbox", JSON.stringify({ id: "INBOX:1", op: "mark_read" }));
    expect(nudges).toEqual([]);
  });

  test("ignores a malformed event body", () => {
    const { sources, deps } = fakeDeps();
    const nudges: string[] = [];
    subscribeMailbox("tnt_1", (event) => nudges.push(event.id), deps);
    expect(() => sources[0]!.emit("mailbox", "not json")).not.toThrow();
    expect(nudges).toEqual([]);
  });

  test("isOpen reflects open/error state", () => {
    const { sources, deps } = fakeDeps();
    const subscription = subscribeMailbox("tnt_1", () => {}, deps);
    expect(subscription.isOpen()).toBe(false);
    sources[0]!.emit("open", "");
    expect(subscription.isOpen()).toBe(true);
    sources[0]!.emit("error", "");
    expect(subscription.isOpen()).toBe(false);
  });

  test("reconnects with capped exponential backoff on repeated errors", () => {
    const { sources, timers, deps } = fakeDeps();
    subscribeMailbox("tnt_1", () => {}, deps);
    sources[0]!.emit("error", "");
    expect(timers[0]!.ms).toBe(1_000);
    timers[0]!.callback();
    sources[1]!.emit("error", "");
    expect(timers[1]!.ms).toBe(2_000);
  });

  test("closes the source and stops reconnecting once unsubscribed", () => {
    const { sources, timers, deps } = fakeDeps();
    const subscription = subscribeMailbox("tnt_1", () => {}, deps);
    subscription.unsubscribe();
    expect(sources[0]!.closed).toBe(true);
    sources[0]!.emit("mailbox", JSON.stringify({ id: "INBOX:1", op: "create" }));
    expect(timers).toEqual([]);
  });
});
