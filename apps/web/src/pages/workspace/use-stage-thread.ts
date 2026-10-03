/**
 * The stage's mail thread: read on the mailbox stream's nudge (CL-8694 — a
 * specialist reply lands as a `create` event the moment it's sent), with a
 * fallback poll covering the stream being down so a dropped connection
 * never strands the person waiting on a reply that already arrived.
 *
 * The read spans every address the stage specialist has ever run at
 * (`agentAddresses`, `useStageAgent`), not just the current live one
 * (`agentAddress`) — a restart or a model switch redeploys the specialist to
 * a fresh address, and the earlier deployment's mail is still the stage's
 * history, not a different conversation (CL-8927). A send always targets
 * `agentAddress` alone.
 */
import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiFailure } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { keys } from "../../queries/keys.ts";
import { useMailboxNudge } from "../../queries/use-mailbox.ts";

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

const NO_MESSAGES: ChatMessage[] = [];

export function useStageThread(
  tenantId: string,
  agentAddress: string | null,
  agentAddresses: readonly string[],
  onNudge: () => void,
  onError: (message: string) => void,
): StageThreadState {
  // The workflow's own decisions (an approval landing, a send-back) land as
  // run events on this same tenant mailbox stream, so a nudge re-reads the
  // workflow view too.
  const backstop = useMailboxNudge(agentAddress ? tenantId : null, onNudge);
  const addresses = agentAddresses.length > 0 ? agentAddresses : agentAddress ? [agentAddress] : [];
  const query = useQuery({
    queryKey: [...keys.thread.of(tenantId, addresses), agentAddress],
    queryFn: async () => ({ messages: await api.readStageThread(tenantId, [...addresses]), loadedFor: agentAddress }),
    enabled: agentAddress !== null,
    refetchInterval: backstop,
    // A redeploy of the same stage's specialist only adds an address, so its
    // history stays on screen while the wider read lands; a disjoint set is
    // a different specialist and starts empty.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId && (previousQuery.queryKey[2] as string[]).some((address) => addresses.includes(address))
        ? previous
        : undefined,
  });

  useEffect(() => {
    if (!query.error) return;
    const cause = query.error;
    onError(`The conversation for this stage could not be read: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.error]);

  const { refetch } = query;
  const reload = useCallback(async () => {
    if (agentAddress) await refetch();
  }, [agentAddress, refetch]);

  return { messages: query.data?.messages ?? NO_MESSAGES, loadedFor: query.data?.loadedFor ?? null, reload };
}
