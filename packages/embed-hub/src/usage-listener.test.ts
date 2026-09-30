import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { createEventCollectorRegistry, createSidecarEmitter } from "@intx/hub-sessions";
import { parseInferenceEvent, type TokenUsage } from "@intx/types/runtime";
import type { SpendUsage } from "./spend.js";
import { listenForUsage } from "./usage-listener.js";

const ADDRESS = "run@tenant.test";
const SOURCE = { sourceId: "src_1", provider: "anthropic", model: "claude" };

function usage(input: number, output: number): TokenUsage {
  return { input, output, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

let seq = 0;
function event(kind: string, data: unknown): unknown {
  const built = { type: kind, seq: ++seq, data };
  if (parseInferenceEvent(built) instanceof type.errors) throw new Error(`invalid test event ${kind}`);
  return built;
}

const start = () => event("inference.start", { model: SOURCE.model });
const running = (u: TokenUsage) => event("inference.usage", { usage: u, source: SOURCE });
const done = (u: TokenUsage) =>
  event("inference.done", {
    turn: { role: "assistant", content: [{ type: "text", text: "ok" }], model: SOURCE.model, timestamp: 0 },
    usage: u,
    source: SOURCE,
  });
const toolDone = () => event("tool.done", { result: { callId: "call_1", content: "result" } });
const reactorDone = () => event("reactor.done", {});
const reply = () => event("connector.reply", { content: "hi" });
const reactorError = (fatal: boolean) => event("reactor.error", { error: "boom", fatal });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(tenant: string | null = "tnt_1") {
  const events = createSidecarEmitter();
  const recorded: SpendUsage[] = [];
  const lookups: string[] = [];
  const stop = listenForUsage({
    events,
    resolveTenantId: async (address) => {
      lookups.push(address);
      return tenant;
    },
    record: (u) => recorded.push(u),
  });
  const send = (e: unknown) => events.emit("agent.event", { agentAddress: ADDRESS, sessionId: "ses_1", event: e });
  const disconnect = () => events.emit("sidecar.disconnect", { ownedAddresses: [ADDRESS] });
  return { recorded, lookups, send, disconnect, stop };
}

// The vendored collector's own usage reports for the same event sequence,
// over a fake DB that accepts its turn writes.
async function collectorUsage(sequence: unknown[]): Promise<TokenUsage[]> {
  const db = {
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  const reported: TokenUsage[] = [];
  const registry = createEventCollectorRegistry({
    db: db as never,
    onUsage: (_address, u) => reported.push(u.usage),
  });
  registry.create(ADDRESS, "tnt_1", "ses_1", "run_1");
  for (const e of sequence) {
    const parsed = parseInferenceEvent(e);
    if (parsed instanceof type.errors) throw new Error("invalid event");
    registry.dispatch(ADDRESS, parsed);
  }
  await settle();
  return reported;
}

describe("listenForUsage", () => {
  test("reports the same usage as the event collector across a multi-step turn with tools", async () => {
    const sequence = [
      start(),
      running(usage(5, 1)),
      done(usage(10, 4)),
      toolDone(),
      start(),
      running(usage(20, 2)),
      done(usage(30, 6)),
      reply(),
      start(),
      done(usage(7, 7)),
      reactorError(true),
    ];
    const { recorded, send } = harness();
    for (const e of sequence) send(e);
    await settle();

    expect(recorded.map((r) => r.usage)).toEqual(await collectorUsage(sequence));
    expect(recorded.map((r) => r.usage)).toEqual([usage(10, 4), usage(30, 6), usage(7, 7)]);
    expect(recorded.every((r) => r.tenantId === "tnt_1" && r.provider === "anthropic" && r.model === "claude")).toBe(
      true,
    );
  });

  test("a non-fatal reactor.error does not end the turn", async () => {
    const { recorded, send } = harness();
    send(start());
    send(done(usage(3, 3)));
    send(reactorError(false));
    await settle();
    expect(recorded).toEqual([]);
    send(reactorDone());
    await settle();
    expect(recorded.map((r) => r.usage)).toEqual([usage(3, 3)]);
  });

  test("records a turn still open when its sidecar disconnects, once", async () => {
    const { recorded, send, disconnect } = harness();
    send(start());
    send(running(usage(9, 1)));
    disconnect();
    disconnect();
    send(reactorDone());
    await settle();
    expect(recorded.map((r) => r.usage)).toEqual([usage(9, 1)]);
  });

  test("resolves the tenant once per turn, so a failed lookup costs only that turn", async () => {
    const events = createSidecarEmitter();
    const recorded: SpendUsage[] = [];
    let calls = 0;
    listenForUsage({
      events,
      resolveTenantId: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db unavailable");
        return "tnt_1";
      },
      record: (u) => recorded.push(u),
    });
    const send = (e: unknown) => events.emit("agent.event", { agentAddress: ADDRESS, sessionId: "ses_1", event: e });
    send(start());
    send(done(usage(1, 1)));
    send(start());
    send(done(usage(2, 2)));
    send(reactorDone());
    await settle();
    expect(calls).toBe(2);
    expect(recorded.map((r) => r.usage)).toEqual([usage(2, 2)]);
  });

  test("ignores usage outside an open turn, as the collector does", async () => {
    const sequence = [done(usage(9, 9)), start(), done(usage(1, 1)), reply(), done(usage(5, 5)), reactorDone()];
    const { recorded, send, disconnect } = harness();
    for (const e of sequence) send(e);
    disconnect();
    await settle();
    expect(recorded.map((r) => r.usage)).toEqual(await collectorUsage(sequence));
    expect(recorded.map((r) => r.usage)).toEqual([usage(1, 1)]);
  });

  test("ignores events that fail validation without disturbing an open turn", async () => {
    const { recorded, send } = harness();
    send(start());
    send(done(usage(4, 2)));
    send({ type: "reactor.done" });
    send("garbage");
    await settle();
    expect(recorded).toEqual([]);
    send(reactorDone());
    await settle();
    expect(recorded.map((r) => r.usage)).toEqual([usage(4, 2)]);
  });

  test("drops usage for an address that resolves to no tenant", async () => {
    const { recorded, send } = harness(null);
    send(start());
    send(done(usage(1, 1)));
    send(reactorDone());
    await settle();
    expect(recorded).toEqual([]);
  });

  test("stops recording once unsubscribed", async () => {
    const { recorded, send, stop } = harness();
    stop();
    send(start());
    send(done(usage(1, 1)));
    send(reactorDone());
    await settle();
    expect(recorded).toEqual([]);
  });
});
