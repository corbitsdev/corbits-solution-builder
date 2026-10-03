import { useQueries } from "@tanstack/react-query";
import { api, ApiFailure } from "../../client.js";
import { keys } from "../../queries/keys.ts";
import { useMailboxNudge } from "../../queries/use-mailbox.ts";

export type WaitingReply = { readonly key: string; readonly address: string; readonly requestedAt: number };

export type WaitingOutcome = { readonly status: "done"; readonly reply: string } | { readonly status: "error"; readonly error: string };

/**
 * Reads each waiting request's thread back until a reply newer than the
 * request lands: a mailbox nudge wakes the read at once, a slow backstop
 * covers a missed one, and nothing is ever resent. Two readers of the same
 * address share one read. Returns what has settled, by request key, for the
 * caller to apply as it renders.
 */
export function useWaitingReplies(tenantId: string, waiting: readonly WaitingReply[]): ReadonlyMap<string, WaitingOutcome> {
  const backstop = useMailboxNudge(waiting.length > 0 ? tenantId : null);
  return useQueries({
    queries: waiting.map((entry) => ({
      queryKey: keys.thread.of(tenantId, [entry.address]),
      queryFn: () => api.readStageThread(tenantId, [entry.address]),
      refetchInterval: backstop,
    })),
    combine: (results) => {
      const settled = new Map<string, WaitingOutcome>();
      results.forEach((result, index) => {
        const entry = waiting[index];
        if (!entry) return;
        const reply = result.data?.find((message) => message.author === "agent" && Date.parse(message.at) >= entry.requestedAt);
        if (reply) settled.set(entry.key, { status: "done", reply: reply.body });
        // An error from a read before this request is not this request's failure.
        else if (result.error && result.errorUpdatedAt >= entry.requestedAt) settled.set(entry.key, { status: "error", error: result.error instanceof ApiFailure ? result.error.detail.message : String(result.error) });
      });
      return settled;
    },
  });
}
