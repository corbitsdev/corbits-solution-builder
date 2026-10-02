/**
 * The specialist run's state for the chat's busy indicator (#445): read
 * off the hub's run log, so "working" is a fact about the run rather than
 * a guess from unanswered mail. Polled: every 3 s while the run is working
 * or the mailbox has a turn with no reply (a reply is seconds to minutes
 * away), every 20 s otherwise, and once more on every thread change, which
 * is when the mailbox stream has just said something landed.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../client.js";
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
  const [state, setState] = useState<SpecialistRun>(UNKNOWN_RUN);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!agentAddress) {
      setState(UNKNOWN_RUN);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      const next = await api.stageSpecialistRunState(projectId, stage);
      if (cancelled) return;
      setState(next);
      const active = next.state === "working" || mailPending;
      timer = setTimeout(() => void read(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `threadKey` re-reads on every thread change: a landed reply or a sent turn.
  }, [projectId, stage, agentAddress, mailPending, threadKey]);

  return state;
}
