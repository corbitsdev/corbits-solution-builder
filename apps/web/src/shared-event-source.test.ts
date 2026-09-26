import { describe, expect, test } from "bun:test";
import { createSharedEventSources, type RawEventSource } from "./shared-event-source.ts";

class FakeRaw implements RawEventSource {
  static opened: FakeRaw[] = [];
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeRaw.opened.push(this);
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data = ""): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  close(): void {
    this.closed = true;
  }
}

function harness(visible = true) {
  FakeRaw.opened = [];
  const state = { visible };
  const shared = createSharedEventSources({ createRaw: (url) => new FakeRaw(url), visible: () => state.visible });
  return { shared, state, raws: () => FakeRaw.opened, live: () => FakeRaw.opened.filter((raw) => !raw.closed) };
}

const URL = "http://host/api/tenants/t1/mailbox/me/inbox/events";

describe("shared event sources (#91)", () => {
  test("subscribers on one URL share one connection, each hearing every event", () => {
    const { shared, raws, live } = harness();
    const a = shared.open(URL, true);
    const b = shared.open(URL, true);
    const heard: string[] = [];
    a.addEventListener("mailbox", (event) => heard.push(`a:${event.data}`));
    b.addEventListener("mailbox", (event) => heard.push(`b:${event.data}`));
    expect(raws().length).toBe(1);
    raws()[0]!.emit("mailbox", "x");
    expect(heard).toEqual(["a:x", "b:x"]);
    a.close();
    expect(live().length).toBe(1);
    raws()[0]!.emit("mailbox", "y");
    expect(heard).toEqual(["a:x", "b:x", "b:y"]);
    b.close();
    expect(live().length).toBe(0);
    expect(shared.connections()).toBe(0);
  });

  test("different URLs are different connections; a type registered later is wired onto the live source", () => {
    const { shared, raws } = harness();
    const a = shared.open(URL, true);
    shared.open("http://host/api/me/inbox/events", true);
    expect(raws().length).toBe(2);
    const heard: string[] = [];
    a.addEventListener("rebuilt", (event) => heard.push(event.data));
    raws()[0]!.emit("rebuilt", "now");
    expect(heard).toEqual(["now"]);
  });

  test("a hidden tab holds no connections; looking at it again reopens them and announces open", () => {
    const { shared, state, raws, live } = harness();
    const a = shared.open(URL, true);
    const opens: number[] = [];
    a.addEventListener("open", () => opens.push(1));
    expect(live().length).toBe(1);
    state.visible = false;
    shared.hidden();
    expect(live().length).toBe(0);
    expect(shared.connections()).toBe(0);
    // Subscribing while hidden opens nothing yet.
    const b = shared.open(URL, true);
    expect(raws().length).toBe(1);
    state.visible = true;
    shared.visible();
    expect(live().length).toBe(1);
    expect(raws().length).toBe(2);
    expect(opens).toEqual([1]);
    a.close();
    b.close();
    expect(live().length).toBe(0);
  });
});
