import { useEffect } from "react";
import { useQueries } from "@tanstack/react-query";
import { api, ApiFailure } from "../../client.js";
import { keys } from "../../queries/keys.ts";
import { useMailboxNudge } from "../../queries/use-mailbox.ts";

export type WaitingReply = { readonly key: string; readonly address: string; readonly requestedAt: number };

/**
 * Reads each waiting request's thread back until a reply newer than the
 * request lands: a mailbox nudge wakes the read at once, a slow backstop
 * covers a missed one, and nothing is ever resent. Two readers of the same
 * address share one read.
 */
export function useWaitingReplies(
  tenantId: string,
  waiting: readonly WaitingReply[],
  onReply: (key: string, body: string) => void,
  onFail: (key: string, message: string) => void,
): void {
  const backstop = useMailboxNudge(waiting.length > 0 ? tenantId : null);
  const results = useQueries({
    queries: waiting.map((entry) => ({
      queryKey: keys.thread.of(tenantId, [entry.address]),
      queryFn: () => api.readStageThread(tenantId, [entry.address]),
      refetchInterval: backstop,
    })),
  });
  const signature = results.map((result) => `${String(result.dataUpdatedAt)}:${String(result.errorUpdatedAt)}`).join("|");
  useEffect(() => {
    results.forEach((result, index) => {
      const entry = waiting[index];
      if (!entry) return;
      const reply = result.data?.find((message) => message.author === "agent" && Date.parse(message.at) >= entry.requestedAt);
      if (reply) onReply(entry.key, reply.body);
      else if (result.error) onFail(entry.key, result.error instanceof ApiFailure ? result.error.detail.message : String(result.error));
    });
    // Re-run when a read lands, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, waiting.map((entry) => entry.key).join("|")]);
}
