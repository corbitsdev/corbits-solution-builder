/**
 * The project workflow view (CL-8721) — the ONLY authority for a stage's
 * current position (CL-8687). There is no artifact-derived fallback: while
 * the view is still loading, `stage` stays unresolved rather than guessing,
 * so the person never sees a stage briefly flash to something the workflow
 * never said.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../client.js";
import { describeFailure } from "./failure-message.ts";
import { describeReplay } from "./replay-notice.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { queryClient } from "../../queries/client.ts";
import { keys } from "../../queries/keys.ts";
import { withinBound } from "../../single-flight.ts";

export type WorkflowViewState = {
  /** Null while unresolved; the workflow's word once it has one. */
  readonly view: ProjectWorkflowView | null;
  readonly resolved: boolean;
  /** The workflow failed to start or load — drive the failure state, never a guessed stage. */
  readonly openingFailed: boolean;
  readonly startError: string | null;
  /** The first read after ensure failed: the reason, for the banner (#570). */
  readonly viewError: string | null;
  /** The last quiet re-read failed: what is shown is the last view that was
   *  read, and may be behind. Cleared by the next re-read that lands. */
  readonly reloadError: string | null;
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

// Re-entering a project this session already has a workflow view for: a
// thin snapshot so the pane renders that view immediately instead of a blank
// "resolved: false" while the mount effect below re-confirms it off the hub.
// Never the source of truth -- every mount still re-reads before trusting it,
// and a stale or wrong snapshot only ever costs one extra render, never a
// wrong decision (nothing here gates `decide`).
const viewSnapshots = new Map<string, ProjectWorkflowView>();

/** How long a person-triggered refresh may hold the busy flag before letting go (#746). */
const REFRESH_BUSY_LIMIT_MS = 20_000;

/** How long the view waits for a missed nudge before re-reading on its own. */
const VIEW_BACKSTOP_MS = 5_000;

/** The non-deploying read of the view: the poll, a nudge and the mount's instant paint all share it. */
function workflowViewQuery(projectId: string) {
  return queryOptions({
    queryKey: keys.workflowView.of(projectId),
    queryFn: () => api.projectWorkflowView(projectId),
  });
}

export function useWorkflowView(projectId: string, onArtifactsChanged: () => void): WorkflowViewState {
  const [view, setView] = useState<ProjectWorkflowView | null>(() => viewSnapshots.get(projectId) ?? null);
  const [startError, setStartError] = useState<string | null>(null);
  const [replayNotice, setReplayNotice] = useState<{ title: string; detail: string } | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [refreshingAfterAction, setRefreshingAfterAction] = useState(false);

  // The quiet re-read is a query (#702). Its backstop poll: the workflow's
  // own decisions do not land on the tenant mailbox stream, so they cannot
  // rely on `subscribeMailbox`'s nudge alone; a missed nudge costs one tick,
  // not a stage sitting stale. The query runs one read at a time (#746): a
  // tick or a nudge while a read is outstanding joins it, so a slow host
  // costs one connection, never one per tick until the browser's per-origin
  // limit stalls every request to the host.
  const query = useQuery({ ...workflowViewQuery(projectId), refetchInterval: VIEW_BACKSTOP_MS });
  const latest = query.data;
  useEffect(() => {
    if (latest && latest.stage >= 1) {
      setView(latest);
      viewSnapshots.set(projectId, latest);
    }
  }, [latest, projectId]);
  // Said, not dropped (#570): the view on screen is the last one read, and
  // the person deciding on it should know it may be behind. The query clears
  // its error on the next read that lands.
  const reloadFailure = query.error;
  useEffect(() => {
    setReloadError(reloadFailure ? describeFailure(reloadFailure) : null);
  }, [reloadFailure]);

  const refetch = query.refetch;
  const reload = useCallback(async () => {
    // A nudge never cancels a read already in flight: it joins it.
    const result = await refetch({ cancelRefetch: false });
    return result.data ?? null;
  }, [refetch]);

  const refresh = useCallback(async () => {
    setRefreshingAfterAction(true);
    try {
      // The busy flag lets go after a bound (#746); the read's result
      // still lands through `reload` when it comes.
      await withinBound(reload(), REFRESH_BUSY_LIMIT_MS);
    } finally {
      setRefreshingAfterAction(false);
    }
    onArtifactsChanged();
  }, [reload, onArtifactsChanged]);

  const retryOpening = useCallback(() => {
    setStartError(null);
    setViewError(null);
    setAttempt((value) => value + 1);
  }, []);

  const markStage = useCallback((stage: number) => {
    setView((current) => (current ? { ...current, stage } : current));
  }, []);

  // Re-entering a project whose workflow is already live: paint it
  // immediately with the same non-deploying read `reload` uses
  // (`projectWorkflowView`, backed by `findProjectWorkflow`/
  // `resolveProjectWorkflowRef`) instead of blocking on
  // `ensureProjectWorkflow`'s deploy-and-wait path.
  //
  // This attach is display-only, never a substitute for ensure:
  // `findProjectWorkflow`'s own `projectRunState` deliberately returns the
  // OLDEST DEAD deployment's ref (`live: false`) rather than flash the view
  // back to stage 1, so a plain read can never tell "live" from "needs
  // reviving onto a fresh deployment" on its own -- only `ensureProjectWorkflow`
  // does that (its replacement-wait + `catchUp` replay). So `ensureProjectWorkflow`
  // still runs every mount, in the background, after the instant paint above
  // -- never awaited before rendering, but never skipped either. A newer
  // view it turns up lands the same way it always has; a failure surfaces
  // through `startError` exactly as before attach existed. `attempt` (Retry)
  // skips the instant paint and goes straight to ensure: a failed open is
  // exactly the case that needs it to run again, not another stale read.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (attempt === 0) {
        // The same query the poll reads, so this joins the read the query
        // started on mount rather than making a second one.
        const attached = await queryClient.fetchQuery(workflowViewQuery(projectId)).catch(() => null);
        if (cancelled) return;
        if (attached && attached.stage >= 1) {
          setView(attached);
          viewSnapshots.set(projectId, attached);
        }
      }
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
      } catch (cause) {
        if (!cancelled) setViewError(describeFailure(cause));
        return;
      }
      if (!cancelled) {
        setView(next);
        if (next) {
          viewSnapshots.set(projectId, next);
          queryClient.setQueryData(workflowViewQuery(projectId).queryKey, next);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  // Belt-and-braces against a missed remount: `key={detail.project.id}` on
  // the component already resets all of this per project; this clears the
  // previous project's view even if that remount ever regresses. Seeds from
  // this project's own snapshot (if any) rather than null, so it cannot
  // undo the instant-render attach the effect above just did in the same
  // commit.
  useEffect(() => {
    setView(viewSnapshots.get(projectId) ?? null);
    setStartError(null);
    setReplayNotice(null);
    setViewError(null);
    setReloadError(null);
  }, [projectId]);

  return {
    view,
    resolved: view !== null,
    openingFailed: startError !== null || viewError !== null,
    startError,
    viewError,
    reloadError,
    replayNotice,
    retryOpening,
    refreshingAfterAction,
    refresh,
    reload,
    markStage,
  };
}
