/**
 * The stage's mail thread: read on the mailbox stream's nudge (CL-8694 — a
 * specialist reply lands as a `create` event the moment it's sent), with a
 * 20s fallback poll covering the stream being down so a dropped connection
 * never strands the person waiting on a reply that already arrived.
 *
 * The read spans every address the stage specialist has ever run at
 * (`agentAddresses`, `useStageAgent`), not just the current live one
 * (`agentAddress`) — a restart or a model switch redeploys the specialist to
 * a fresh address, and the earlier deployment's mail is still the stage's
 * history, not a different conversation (CL-8927). A send always targets
 * `agentAddress` alone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { shouldFallbackRefetch, subscribeMailbox } from "../../mailbox-events.ts";

export type StageThreadState = {
  readonly messages: ChatMessage[];
  /** Which address `messages` reflects the CURRENT live deployment for — the
   *  opening-send logic must never judge the live address's thread empty off
   *  a read that hasn't landed for it yet (CL-8656). Set once the merged
   *  read (across every known address) completes for a given live address,
   *  even though the read itself covers more than that one address. */
  readonly loadedFor: string | null;
  readonly reload: () => Promise<void>;
};

export function useStageThread(
  tenantId: string,
  agentAddress: string | null,
  agentAddresses: readonly string[],
  onNudge: () => void,
  onError: (message: string) => void,
): StageThreadState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const lastLoadAt = useRef(0);
  const addressesRef = useRef<readonly string[]>(agentAddresses);
  addressesRef.current = agentAddresses;
  const addressesKey = agentAddresses.join(",");

  const reload = useCallback(async () => {
    if (!agentAddress) return;
    const loadedAddress = agentAddress;
    const addresses = addressesRef.current.length > 0 ? [...addressesRef.current] : [agentAddress];
    try {
      const result = await api.readStageThread(tenantId, addresses);
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

  // A genuinely different stage (a disjoint address set — a different
  // specialist asset entirely) starts with no known thread state: clear the
  // previous stage's messages rather than let them linger until the next
  // poll resolves. A redeploy of the SAME stage's specialist only adds an
  // address to the set (the old ones are still valid history), so that case
  // is deliberately not cleared — the merged reload below still picks up the
  // rest of the history alongside the new address's mail.
  const previousAddressesRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const previous = previousAddressesRef.current;
    previousAddressesRef.current = agentAddresses;
    const disjoint =
      previous.length > 0 && agentAddresses.length > 0 && !agentAddresses.some((address) => previous.includes(address));
    if (disjoint) {
      setMessages([]);
      setLoadedFor(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressesKey]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentAddress, addressesKey, tenantId, reload, onNudge]);

  return { messages, loadedFor, reload };
}
