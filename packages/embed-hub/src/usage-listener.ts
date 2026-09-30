/**
 * Records inference spend straight from the sidecar router's `agent.event`
 * stream. Interchange's event collector reports the same usage through
 * `onUsage`, but only for a collector created against an `agent_session`
 * row, which Interchange never creates for a workflow run.
 *
 * A turn's usage is flushed at the same boundaries the collector uses
 * (`vendor/interchange/packages/hub-sessions/src/event-collector.ts`): the
 * next `inference.start`, `reactor.done`, `connector.reply`, and a fatal
 * `reactor.error`. Unlike the collector, a turn still open when its sidecar
 * disconnects is flushed too: the provider has already billed it.
 */
import { type } from "arktype";
import { parseInferenceEvent, type LastCycleSource, type TokenUsage } from "@intx/types/runtime";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import type { SpendUsage } from "./spend.js";

const OBSERVED_EVENTS = new Set([
  "inference.start",
  "inference.usage",
  "inference.done",
  "reactor.done",
  "connector.reply",
  "reactor.error",
]);

function isObservedEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && "type" in event && OBSERVED_EVENTS.has(String(event.type));
}

type OpenTurn = {
  // Resolved when the turn starts, not at flush time: a flush on disconnect
  // races the run's teardown, and the address may no longer resolve.
  readonly tenantId: Promise<string | null>;
  usage?: TokenUsage;
  source?: LastCycleSource;
};

export function listenForUsage(deps: {
  readonly events: SidecarEventEmitter;
  readonly resolveTenantId: (address: string) => Promise<string | null>;
  readonly record: (usage: SpendUsage) => void;
}): () => void {
  const { events, resolveTenantId, record } = deps;
  const turns = new Map<string, OpenTurn>();

  function open(address: string): void {
    const tenantId = resolveTenantId(address).catch((err: unknown) => {
      console.error(
        `usage listener: resolving the tenant for ${address} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    turns.set(address, { tenantId });
  }

  function flush(address: string, interrupted: boolean): void {
    const turn = turns.get(address);
    if (turn === undefined) return;
    turns.delete(address);
    const { usage, source } = turn;
    if (usage === undefined || source === undefined) return;
    void turn.tenantId.then((tenantId) => {
      if (tenantId === null) {
        console.error(`usage listener: dropping usage for ${address}: no tenant resolves for it`);
        return;
      }
      if (interrupted) {
        console.info(
          `usage listener: recording interrupted usage for ${address} (tenant ${tenantId}, ${source.provider}/${source.model})`,
        );
      }
      record({ tenantId, provider: source.provider, model: source.model, usage });
    });
  }

  const offEvent = events.on("agent.event", ({ agentAddress, event }) => {
    // Most events are streaming deltas this ignores; skip them before paying
    // for full validation.
    if (!isObservedEvent(event)) return;
    const parsed = parseInferenceEvent(event);
    if (parsed instanceof type.errors) return;
    switch (parsed.type) {
      case "inference.start":
        flush(agentAddress, false);
        open(agentAddress);
        break;
      case "inference.usage":
      case "inference.done": {
        const turn = turns.get(agentAddress);
        if (turn === undefined) break;
        turn.usage = parsed.data.usage;
        turn.source = parsed.data.source;
        break;
      }
      case "reactor.done":
      case "connector.reply":
        flush(agentAddress, false);
        break;
      case "reactor.error":
        if (parsed.data.fatal) flush(agentAddress, false);
        break;
      default:
        break;
    }
  });

  const offDisconnect = events.on("sidecar.disconnect", ({ ownedAddresses }) => {
    for (const address of ownedAddresses) flush(address, true);
  });

  return () => {
    offEvent();
    offDisconnect();
  };
}
