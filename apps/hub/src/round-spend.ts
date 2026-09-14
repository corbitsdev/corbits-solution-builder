/**
 * A stage round's spend, read from the run's own inference events.
 *
 * The platform runs each stage round as a workflow step under a sidecar,
 * and the sidecar forwards the step's inference stream to the hub as
 * `agent.event` frames. Each `inference.done` is one call to a provider,
 * carrying the call's final token counts and the adapter and model that
 * answered. That is the record: one per call, attributed to the project
 * whose run the frame's address names.
 *
 * Interchange's own event collector registry has an `onUsage` sink for the
 * same purpose, but in the vendored revision nothing creates a collector, so
 * its `dispatch` drops every frame and the sink never fires. This listener
 * is the one recording path; the registry is mounted without a sink so a
 * later revision that does create collectors cannot count a call twice.
 *
 * Read only: nothing here makes a provider call or infers a cost. A call the
 * stream did not report is not recorded, and one it reported without counts
 * is recorded as a call with none.
 */
import { parseRunAddress } from "@intx/types";
import { hub } from "./hub-mount.js";
import { catalog } from "./hub-client.js";
import { projectForRun } from "./hub-executor.js";
import { recordRoundUsage, type TokenCounts } from "./spend.js";

let attached = false;

/** What an `inference.done` frame is read as; anything else is not a call. */
type InferenceDone = {
  type?: unknown;
  data?: { usage?: Partial<TokenCounts> | null; source?: { provider?: unknown; model?: unknown } | null };
};

/**
 * Subscribes once to the hub's sidecar events and records each round call
 * on its project. Idempotent, like the live-draft feeder beside it: mounting
 * the hub twice in a process does not stack a second listener.
 */
export function attachRoundSpend(): void {
  if (attached) return;
  attached = true;
  hub().events.on("agent.event", ({ agentAddress, event }) => {
    const frame = event as InferenceDone;
    if (frame.type !== "inference.done") return;
    const address = parseRunAddress(agentAddress);
    if (!address) return;
    void recordRoundCall(address.runId, frame).catch((cause: unknown) => {
      console.error("[spend] a round's call could not be recorded", cause);
    });
  });
}

async function recordRoundCall(runId: string, frame: InferenceDone): Promise<void> {
  const projectId = await projectForRun(runId);
  if (!projectId) return;
  const source = frame.data?.source;
  const usage = frame.data?.usage;
  const adapter = typeof source?.provider === "string" ? source.provider : "unknown";
  const model = typeof source?.model === "string" ? source.model : "unknown";
  await recordRoundUsage({
    projectId,
    runId,
    provider: await providerServing(adapter, model),
    model,
    tokens: usage
      ? {
          input: Number(usage.input ?? 0),
          output: Number(usage.output ?? 0),
          cacheRead: Number(usage.cacheRead ?? 0),
          cacheWrite: Number(usage.cacheWrite ?? 0),
          thinking: Number(usage.thinking ?? 0),
        }
      : null,
  });
}

/**
 * The connected provider a round's call went to, in the name the host
 * records its own calls under. The platform names the adapter that served
 * the call (`openai-compatible`), which several connected providers may
 * share; the one whose catalog row runs that adapter and lists that model
 * is the one that answered. When that is not exactly one row, the adapter's
 * name stands, which is still true.
 */
async function providerServing(adapter: string, model: string): Promise<string> {
  let providers: Awaited<ReturnType<typeof catalog.modelProviders>>;
  let models: Awaited<ReturnType<typeof catalog.models>>;
  let offerings: Awaited<ReturnType<typeof catalog.offerings>>;
  try {
    [providers, models, offerings] = await Promise.all([catalog.modelProviders(), catalog.models(), catalog.offerings()]);
  } catch {
    return adapter;
  }
  const modelIds = new Set(models.filter((entry) => entry.canonicalName === model).map((entry) => entry.id));
  const serving = providers.filter(
    (row) => row.plugin === adapter && offerings.some((offering) => offering.providerId === row.id && modelIds.has(offering.modelId)),
  );
  return serving.length === 1 ? serving[0]!.name : adapter;
}
