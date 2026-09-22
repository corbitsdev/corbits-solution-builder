/**
 * The stage's mail thread: read on the mailbox stream's nudge (CL-8694 — a
 * specialist reply lands as a `create` event the moment it's sent), with a
 * 20s fallback poll covering the stream being down so a dropped connection
 * never strands the person waiting on a reply that already arrived.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { shouldFallbackRefetch, subscribeMailbox } from "../../mailbox-events.ts";

export type StageThreadState = {
  readonly messages: ChatMessage[];
  /** Which address `messages` actually reflects — the opening-send logic
   *  must never judge a fresh address's thread empty off stale data still
   *  held over from the previous one (CL-8656). */
  readonly loadedFor: string | null;
  readonly reload: () => Promise<void>;
};

export function useStageThread(
  tenantId: string,
  agentAddress: string | null,
  onNudge: () => void,
  onError: (message: string) => void,
): StageThreadState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const lastLoadAt = useRef(0);

  const reload = useCallback(async () => {
    if (!agentAddress) return;
    const loadedAddress = agentAddress;
    try {
      const result = await api.readStageThread(tenantId, [agentAddress]);
      setMessages(result);
      setLoadedFor(loadedAddress);
      lastLoadAt.current = Date.now();
    } catch (cause) {
      onError(
        `The conversation for this stage could not be read: ${
          cause instanceof ApiFailure ? cause.detail.message : String(cause)
        }`,
      );
    }
  }, [agentAddress, tenantId, onError]);

  // A new address (fresh run replacing a released one, CL-8654) starts with
  // no known thread state: clear the previous address's messages rather than
  // let them linger until the next poll resolves.
  useEffect(() => {
    setMessages([]);
    setLoadedFor(null);
  }, [agentAddress]);

  useEffect(() => {
    if (!agentAddress) return;
    void reload();
    // The workflow's own decisions (an approval landing, a send-back) land as
    // run events on this same tenant mailbox stream — the nudge that already
    // wakes the thread read is just as much a reason to re-read the workflow
    // view, so both go on every nudge rather than leaving the view to the
    // slower backstop poll alone.
    const subscription = subscribeMailbox(tenantId, () => {
      void reload();
      onNudge();
    });
    const timer = setInterval(() => {
      const open = subscription.isOpen();
      const msSinceLastLoad = Date.now() - lastLoadAt.current;
      if (shouldFallbackRefetch({ open, msSinceLastLoad })) {
        void reload();
        onNudge();
      }
    }, 20_000);
    return () => {
      clearInterval(timer);
      subscription.unsubscribe();
    };
  }, [agentAddress, tenantId, reload, onNudge]);

  return { messages, loadedFor, reload };
}
