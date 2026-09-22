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
  /** The hub's own message for a failed deployment, shown verbatim rather
   *  than left to the waiting UI to imply it's still in progress (CL-8612's
   *  502 case: the workspace used to sit on "Starting…" forever). */
  readonly error: string | null;
  readonly retry: () => void;
};

export function useStageAgent(projectId: string, stage: number, workflowResolved: boolean): StageAgentState {
  const [agent, setAgent] = useState<{ stage: number; address: string } | null>(null);
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

  return {
    address: agent?.stage === stage ? agent.address : null,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}
