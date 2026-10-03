import { createSystemOneAdapterFactory } from "@corbits/system-one";
import type { AdapterFactory } from "@intx/inference";

/** The offering quirk naming the score a draft must reach; the client reads it, the adapter does not. */
export const READY_AT_QUIRK = "readyAt";

// An evaluator's run keeps every draft it was mailed in its conversation, and
// a System One model (tev1 holds ~2k tokens and never truncates) scores only
// what it is sent: the latest mail alone, never the history.
export const createClassifierAdapter: AdapterFactory = (source, quirks) => {
  const { [READY_AT_QUIRK]: _readyAt, ...rest } = typeof quirks === "object" && quirks !== null ? (quirks as Record<string, unknown>) : {};
  const adapter = createSystemOneAdapterFactory(source, rest);
  return {
    ...adapter,
    buildRequest: (messages, model, options) =>
      adapter.buildRequest(messages.filter((turn) => turn.role === "user").slice(-1), model, options),
  };
};
