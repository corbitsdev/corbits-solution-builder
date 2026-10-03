/**
 * The stage's specialist deployment (CL-8612 contract v6 — one mail agent
 * per stage, never a lifecycle workflow run). `address` is the single source
 * of truth for "the agent is known": the composer and every stage panel key
 * off it directly rather than a separate readiness flag, so there is no
 * window where the address is known but something built on it is disabled.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiFailure, type Remediation } from "../../client.js";
import { keys } from "../../queries/keys.ts";
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
  /** The way out the failure offered, when it did (an `ApiFailure`'s
   *  `remediation`): e.g. the project has no delegated provider (#29). */
  readonly remediation: Remediation | undefined;
  readonly retry: () => void;
};

const RECHECK_MS = 30_000;

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
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<Remediation | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  // The real stage once the workflow view has resolved it; until then, only
  // the confirmed early stage — never `stage` itself, which is an unresolved
  // display fallback (`workflowView?.stage ?? 1`) rather than a confirmation
  // (CL-8721).
  const deployStage = workflowResolved ? stage : earlyStage;

  // The live pick, re-checked rather than memoised: two sessions racing to
  // open this stage can each deploy a specialist, the hub releases the
  // loser, and a session holding the loser's address would otherwise mail
  // into the void forever (CL-8654). Before an address is known only a
  // "deployed" status counts, as an instant paint on re-entry; once one is,
  // the hub's live pick is followed wherever it moves. The cache outlives the
  // mount, so re-entering a stage renders its address at once.
  const statusKey = keys.stageAgent.status(projectId, deployStage ?? 0);
  const status = useQuery({
    queryKey: statusKey,
    queryFn: async () => {
      const held = queryClient.getQueryData<string | null>(statusKey) ?? null;
      // A failed read is the query's error and keeps the address held; `ensureStageAgent` reports the failure.
      const current = await api.stageAgentStatus(projectId, deployStage!);
      if (!current) return held;
      return held !== null || current.status === "deployed" ? current.address : null;
    },
    enabled: deployStage !== null,
    refetchInterval: RECHECK_MS,
    gcTime: Infinity,
  });

  // The attach above is display-only, never a substitute for ensure: the
  // hub's persisted "deployed" status can outlive a dead sidecar (e.g. after
  // a host restart), so only `ensureStageAgent` can tell "live" from "needs
  // reviving". It runs every mount, in the background, never awaited before
  // rendering but never skipped either (CL-8935).
  useEffect(() => {
    if (deployStage === null) return;
    let cancelled = false;
    const key = keys.stageAgent.status(projectId, deployStage);
    setError(null);
    setRemediation(undefined);
    const ensure = async () => {
      try {
        const deployment = await api.ensureStageAgent(projectId, deployStage);
        await queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData(key, deployment.address);
      } catch (cause) {
        if (cancelled) return;
        setError(describeFailure(cause));
        setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
      }
    };
    void ensure();
    return () => {
      cancelled = true;
    };
  }, [projectId, deployStage, attempt, queryClient]);

  const address = deployStage === stage ? (status.data ?? null) : null;

  // The full address history. It widens only when a redeploy lands a new
  // live address, so it is keyed by that address and read once per address.
  const history = useQuery({
    queryKey: keys.stageAgent.addresses(projectId, stage, address ?? ""),
    queryFn: async () => {
      const list = await api.stageAgentAddresses(projectId, stage);
      return list.length > 0 ? list : [address!];
    },
    enabled: address !== null,
    staleTime: Infinity,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === projectId && previousQuery.queryKey[2] === stage ? previous : undefined,
  });

  return {
    address,
    addresses: address === null ? [] : (history.data ?? [address]),
    error,
    remediation,
    retry: () => setAttempt((value) => value + 1),
  };
}
