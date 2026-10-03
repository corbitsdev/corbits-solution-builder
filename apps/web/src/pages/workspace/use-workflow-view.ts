/**
 * The project workflow view (CL-8721) — the ONLY authority for a stage's
 * current position (CL-8687). There is no artifact-derived fallback: while
 * the view is still loading, `stage` stays unresolved rather than guessing,
 * so the person never sees a stage briefly flash to something the workflow
 * never said.
 */
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../client.js";
import { keys } from "../../queries/keys.ts";
import { describeFailure } from "./failure-message.ts";
import { describeReplay } from "./replay-notice.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";

export type WorkflowViewState = {
  /** Null while unresolved; the workflow's word once it has one. */
  readonly view: ProjectWorkflowView | null;
  readonly resolved: boolean;
  /** The workflow failed to start or load — drive the failure state, never a guessed stage. */
  readonly openingFailed: boolean;
  readonly startError: string | null;
  /** The workflow was moved onto new code, and the new rules refused an
   *  earlier decision (#51): what was refused, in the workflow's own words.
   *  Null when nothing was refused, or no replay happened. */
  readonly replayNotice: { title: string; detail: string } | null;
  /** Retries the ensure + first read after a failure. */
  readonly retryOpening: () => void;
  /** A person-triggered re-read is in flight — lets the approve control tell
   *  "refreshing" from "not allowed" (CL-8687 follow-up). Never set by the
   *  routine poll, which would flicker it on and off every few seconds. */
  readonly refreshingAfterAction: boolean;
  /** Re-reads the view after something the person did may have changed it.
   *  The ONE path every action goes through, so there is exactly one refresh
   *  to reason about. */
  readonly refresh: () => Promise<void>;
  /** The quiet re-read: polls and nudges go through this, no busy flag. */
  readonly reload: () => Promise<ProjectWorkflowView | null>;
  /** Optimistically land a stage the workflow just confirmed (approve /
   *  send-back) ahead of the re-read, so the view never flashes backwards. */
  readonly markStage: (stage: number) => void;
};

/** A backstop only: this client's own decisions refresh on the spot, and the mailbox stream nudges on a run event. */
const BACKSTOP_MS = 30_000;

export function useWorkflowView(projectId: string, onArtifactsChanged: () => void): WorkflowViewState {
  const queryClient = useQueryClient();
  const [startError, setStartError] = useState<string | null>(null);
  const [replayNotice, setReplayNotice] = useState<{ title: string; detail: string } | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refreshingAfterAction, setRefreshingAfterAction] = useState(false);

  // A run that has not written its first state (stage 0) or a failed read
  // never replaces a view already held. The cache outlives the mount, so
  // re-entering a project paints its last view at once while this re-reads.
  const key = keys.workflowView.of(projectId);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const next = await api.projectWorkflowView(projectId).catch(() => null);
      return next && next.stage >= 1 ? next : (queryClient.getQueryData<ProjectWorkflowView | null>(key) ?? null);
    },
    refetchInterval: BACKSTOP_MS,
    gcTime: Infinity,
  });
  const view = query.data ?? null;

  const { refetch } = query;
  const reload = useCallback(async () => (await refetch()).data ?? null, [refetch]);

  const refresh = useCallback(async () => {
    setRefreshingAfterAction(true);
    try {
      await reload();
    } finally {
      setRefreshingAfterAction(false);
    }
    onArtifactsChanged();
  }, [reload, onArtifactsChanged]);

  const retryOpening = useCallback(() => {
    setStartError(null);
    setViewFailed(false);
    setAttempt((value) => value + 1);
  }, []);

  const markStage = useCallback(
    (stage: number) => queryClient.setQueryData<ProjectWorkflowView | null>(key, (current) => (current ? { ...current, stage } : current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, projectId],
  );

  // The query above is display-only, never a substitute for ensure:
  // `findProjectWorkflow`'s own `projectRunState` deliberately returns the
  // OLDEST DEAD deployment's ref (`live: false`) rather than flash the view
  // back to stage 1, so a plain read can never tell "live" from "needs
  // reviving onto a fresh deployment" on its own -- only `ensureProjectWorkflow`
  // does that (its replacement-wait + `catchUp` replay). So it still runs
  // every mount, in the background -- never awaited before rendering, but
  // never skipped either. A failure surfaces through `startError`.
  useEffect(() => {
    let cancelled = false;
    setStartError(null);
    setReplayNotice(null);
    setViewFailed(false);
    (async () => {
      try {
        const ensured = await api.ensureProjectWorkflow(projectId);
        // A replay's refusals are the reducer's own ledger rows; this only
        // reads them out. Set once per ensure, never cleared by a poll.
        if (!cancelled) setReplayNotice(describeReplay(ensured.replay));
      } catch (cause) {
        if (!cancelled) setStartError(describeFailure(cause));
        return;
      }
      let next: ProjectWorkflowView | null;
      try {
        next = await api.projectWorkflowView(projectId);
        // A just-triggered run reports stage 0 until its first state lands.
        for (let tries = 0; next && next.stage < 1 && tries < 120 && !cancelled; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          next = await api.projectWorkflowView(projectId);
        }
        if (next && next.stage < 1) throw new Error("the project workflow did not start");
      } catch {
        if (!cancelled) setViewFailed(true);
        return;
      }
      if (!cancelled && next) queryClient.setQueryData(keys.workflowView.of(projectId), next);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt, queryClient]);

  return {
    view,
    resolved: view !== null,
    openingFailed: startError !== null || viewFailed,
    startError,
    replayNotice,
    retryOpening,
    refreshingAfterAction,
    refresh,
    reload,
    markStage,
  };
}
