/**
 * The specialist run's state for the chat's busy indicator (#445): read
 * off the hub's run log, so "working" is a fact about the run rather than
 * a guess from unanswered mail. Polled: every 3 s while the run is working
 * or the mailbox has a turn with no reply (a reply is seconds to minutes
 * away), every 20 s otherwise, and once more on every thread change, which
 * is when the mailbox stream has just said something landed.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../client.js";
import { keys } from "../../queries/keys.ts";
import { UNKNOWN_RUN, type SpecialistRun } from "../../specialist-run-state.ts";

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 20_000;

export function useSpecialistRunState(
  projectId: string,
  stage: number,
  agentAddress: string | null,
  mailPending: boolean,
  threadKey: string,
): SpecialistRun {
  const query = useQuery({
    // `threadKey` re-reads on every thread change: a landed reply or a sent turn.
    queryKey: [...keys.stageAgent.run(projectId, stage, agentAddress ?? ""), threadKey],
    queryFn: () => api.stageSpecialistRunState(projectId, stage),
    enabled: agentAddress !== null,
    // Only the same deployment's last answer stands in while a thread change re-reads.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[4] === agentAddress ? previous : undefined),
    refetchInterval: (current) => (current.state.data?.state === "working" || mailPending ? ACTIVE_POLL_MS : IDLE_POLL_MS),
  });
  return agentAddress ? (query.data ?? UNKNOWN_RUN) : UNKNOWN_RUN;
}
