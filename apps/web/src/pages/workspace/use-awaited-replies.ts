/**
 * Replies awaited from companion threads (#702): for each wait, the first
 * agent message at or after the request, read through one thread query per
 * address. A mailbox nudge marks the waiting threads stale, so a reply is
 * read the moment it lands; a bounded interval backstops a missed nudge
 * (#777). Nothing is resent: this only reads.
 */
import { useQueries } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../../client.js";
import { subscribeMailbox } from "../../mailbox-events.ts";
import { queryClient } from "../../queries/client.ts";
import { keys } from "../../queries/keys.ts";
import { failureReason } from "./failure-message.ts";

export type ReplyWait = {
  /** The caller's name for the wait, by which its outcome is reported. */
  readonly key: string;
  readonly address: string;
  /** When the request was sent: only a reply from then on answers it. */
  readonly requestedAt: number;
};

export type AwaitedReply = { readonly reply: string } | { readonly error: string };

/**
 * The outcome of each wait that has one: the reply's body, or why the
 * thread could not be read. A wait with neither is still waiting. The
 * result is structurally shared, so an effect on it runs when an outcome
 * changes, not on every render.
 */
export function useAwaitedReplies(tenantId: string, waits: readonly ReplyWait[], backstopMs: number): Readonly<Record<string, AwaitedReply>> {
  const outcomes = useQueries({
    queries: waits.map((wait) => ({
      queryKey: keys.thread.of(tenantId, [wait.address]),
      queryFn: () => api.readStageThread(tenantId, [wait.address]),
      refetchInterval: backstopMs,
    })),
    combine: (results) => {
      const out: Record<string, AwaitedReply> = {};
      results.forEach((result, index) => {
        const wait = waits[index]!;
        const reply = result.data?.find((message) => message.author === "agent" && Date.parse(message.at) >= wait.requestedAt);
        if (reply) out[wait.key] = { reply: reply.body };
        else if (result.error) out[wait.key] = { error: failureReason(result.error) };
      });
      return out;
    },
  });

  // One subscription while anything is waiting; it reads the waits current
  // when the nudge lands, not the ones current when it was opened.
  const waitsRef = useRef(waits);
  waitsRef.current = waits;
  const anyWaiting = waits.length > 0;
  useEffect(() => {
    if (!anyWaiting) return;
    const subscription = subscribeMailbox(tenantId, () => {
      for (const wait of waitsRef.current) void queryClient.invalidateQueries({ queryKey: keys.thread.of(tenantId, [wait.address]) });
    });
    return () => subscription.unsubscribe();
  }, [anyWaiting, tenantId]);

  return outcomes;
}
