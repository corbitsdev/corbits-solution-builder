/**
 * The stage's specialist deployment (CL-8612 contract v6 — one mail agent
 * per stage, never a lifecycle workflow run). `address` is the single source
 * of truth for "the agent is known": the composer and every stage panel key
 * off it directly rather than a separate readiness flag, so there is no
 * window where the address is known but something built on it is disabled.
 */
import { useEffect, useState } from "react";
import { api } from "../../client.js";
import { describeFailure } from "./failure-message.ts";

export type StageAgentState = {
  /** The address for the CURRENT stage — carried with the stage it was
   *  resolved for so a render where `stage` has already advanced never leaks
   *  the previous stage's deployment into a send (CL-8649). */
  readonly address: string | null;
  /** Every address this stage's specialist has ever run at, `address`
   *  included — the input `useStageThread` merges reads across, so a
   *  redeploy (restart, model switch) never empties the stage's chat: an
   *  earlier deployment's mail is still read, just never sent to again
   *  (CL-8927). Empty until the first resolve lands for `stage`. */
  readonly addresses: readonly string[];
  /** The hub's own message for a failed deployment, shown verbatim rather
   *  than left to the waiting UI to imply it's still in progress (CL-8612's
   *  502 case: the workspace used to sit on "Starting…" forever). */
  readonly error: string | null;
  readonly retry: () => void;
};

export function useStageAgent(projectId: string, stage: number, workflowResolved: boolean): StageAgentState {
  const [agent, setAgent] = useState<{ stage: number; address: string } | null>(null);
  const [addresses, setAddresses] = useState<{ stage: number; list: readonly string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The real stage has to be known before a specialist is deployed for it
    // — never for the artifact-derived fallback while the workflow view is
    // still loading (CL-8721).
    if (!workflowResolved) return;
    let cancelled = false;
    const requestedStage = stage;
    setError(null);
    api
      .ensureStageAgent(projectId, requestedStage)
      .then((deployment) => {
        if (!cancelled) setAgent({ stage: requestedStage, address: deployment.address });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeFailure(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stage, workflowResolved, attempt]);

  // Re-checking the agent itself rather than its thread: two sessions racing
  // to open this stage can each deploy a specialist, the hub releases the
  // loser, and a session that memoised the loser's address would otherwise
  // mail into the void forever (CL-8654). When the live pick has moved to a
  // different deployment, follow it.
  useEffect(() => {
    if (!agent || agent.stage !== stage) return;
    const recheck = () => {
      void api
        .stageAgentStatus(projectId, stage)
        .then((current) => {
          if (current && current.address !== agent.address) setAgent({ stage, address: current.address });
        })
        .catch(() => {});
    };
    const timer = setInterval(recheck, 3_000);
    return () => clearInterval(timer);
  }, [agent, projectId, stage]);

  // The full address history, refreshed on the same cadence as the live-pick
  // recheck above — a fresh redeploy (that recheck landing a new
  // `agent.address`) is exactly when this list must widen to include it, or
  // the merged thread read would miss the new deployment's own mail.
  useEffect(() => {
    if (!agent || agent.stage !== stage) return;
    let cancelled = false;
    const load = () => {
      void api
        .stageAgentAddresses(projectId, stage)
        .then((list) => {
          if (!cancelled) setAddresses({ stage, list: list.length > 0 ? list : [agent.address] });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agent, projectId, stage]);

  return {
    address: agent?.stage === stage ? agent.address : null,
    addresses: addresses?.stage === stage ? addresses.list : agent?.stage === stage ? [agent.address] : [],
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}
