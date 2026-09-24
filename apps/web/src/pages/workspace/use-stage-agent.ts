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

// Re-entering a stage this session has already resolved an agent for: a
// thin snapshot so a remount can render its address immediately instead of
// `null` while the mount effect below re-confirms it off the hub. Never the
// source of truth -- every mount still attaches or deploys before trusting
// it, and the CL-8654 re-check effect below keeps following the live pick
// regardless of what this held.
const agentSnapshots = new Map<string, { stage: number; address: string }>();

export function useStageAgent(
  projectId: string,
  stage: number,
  workflowResolved: boolean,
  /** A stage already confirmed by a cheap, non-deploying read (never a
   *  guess — see `index.tsx`'s `confirmedStage`), so the specialist can
   *  start deploying concurrently with the project workflow's own
   *  ensure/poll cycle instead of waiting for it to finish. Null when no
   *  such confirmation exists yet, which keeps this the same
   *  wait-for-`workflowResolved` behavior as before. */
  earlyStage: number | null,
): StageAgentState {
  const [agent, setAgent] = useState<{ stage: number; address: string } | null>(
    () => agentSnapshots.get(`${projectId}:${stage}`) ?? null,
  );
  const [addresses, setAddresses] = useState<{ stage: number; list: readonly string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The real stage once the workflow view has resolved it; until then, only
  // the confirmed early stage — never `stage` itself, which is an unresolved
  // display fallback (`workflowView?.stage ?? 1`) rather than a confirmation
  // (CL-8721).
  const deployStage = workflowResolved ? stage : earlyStage;

  useEffect(() => {
    if (deployStage === null) return;
    let cancelled = false;
    const requestedStage = deployStage;
    setError(null);
    (async () => {
      // Re-entering a stage already deployed and live: attach with the same
      // non-deploying read `stageAgentStatus` (CL-8654's own re-check) uses,
      // for an instant paint, instead of waiting on `ensureStageAgent`'s
      // deploy-and-wait path to render anything.
      //
      // This attach is display-only, never a substitute for ensure: the
      // hub's persisted "deployed" status can outlive a dead sidecar (e.g.
      // after a host restart), so a plain read can never tell "live" from
      // "needs reviving onto a fresh deployment" on its own -- only
      // `ensureStageAgent` does that. So `ensureStageAgent` still runs every
      // mount, in the background, after the instant paint above -- never
      // awaited before rendering, but never skipped either (CL-8935, fixing
      // a regression from #669 where a "deployed" attach returned early and
      // left the composer pointed at a dead sidecar until a manual retry).
      if (attempt === 0) {
        const attached = await api.stageAgentStatus(projectId, requestedStage).catch(() => null);
        if (cancelled) return;
        if (attached && attached.status === "deployed") {
          const next = { stage: requestedStage, address: attached.address };
          setAgent(next);
          agentSnapshots.set(`${projectId}:${requestedStage}`, next);
        }
      }
      await api
        .ensureStageAgent(projectId, requestedStage)
        .then((deployment) => {
          if (!cancelled) {
            const next = { stage: requestedStage, address: deployment.address };
            setAgent(next);
            agentSnapshots.set(`${projectId}:${requestedStage}`, next);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(describeFailure(cause));
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, deployStage, attempt]);

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
          if (current && current.address !== agent.address) {
            const next = { stage, address: current.address };
            setAgent(next);
            agentSnapshots.set(`${projectId}:${stage}`, next);
          }
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
