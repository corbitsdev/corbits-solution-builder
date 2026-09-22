/**
 * The project workflow view (CL-8721) — the ONLY authority for a stage's
 * current position (CL-8687). There is no artifact-derived fallback: while
 * the view is still loading, `stage` stays unresolved rather than guessing,
 * so the person never sees a stage briefly flash to something the workflow
 * never said.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../client.js";
import { describeFailure } from "./failure-message.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";

export type WorkflowViewState = {
  /** Null while unresolved; the workflow's word once it has one. */
  readonly view: ProjectWorkflowView | null;
  readonly resolved: boolean;
  /** The workflow failed to start or load — drive the failure state, never a guessed stage. */
  readonly openingFailed: boolean;
  readonly startError: string | null;
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

export function useWorkflowView(projectId: string, onArtifactsChanged: () => void): WorkflowViewState {
  const [view, setView] = useState<ProjectWorkflowView | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refreshingAfterAction, setRefreshingAfterAction] = useState(false);

  const reload = useCallback(async () => {
    const next = await api.projectWorkflowView(projectId).catch(() => null);
    if (next && next.stage >= 1) setView(next);
    return next;
  }, [projectId]);

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

  const markStage = useCallback((stage: number) => {
    setView((current) => (current ? { ...current, stage } : current));
  }, []);

  // Deployed/triggered once per project, then read on mount and re-read.
  // `ensureProjectWorkflow` and the first `projectWorkflowView` read are each
  // reported on their own terms, so a failure of either says specifically
  // what did not start rather than a generic error. A ref rather than a
  // cancellation flag pattern is NOT used here: `attempt` is the retry, so
  // the effect legitimately re-runs on it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.ensureProjectWorkflow(projectId);
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
      if (!cancelled) setView(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  // Backstop poll — the workflow's own decisions do not land on the tenant
  // mailbox stream, so they cannot rely on `subscribeMailbox`'s nudge alone.
  // 5s, the same cadence `app.tsx` polls the decision fold at: a missed
  // nudge costs one poll tick, not a stage sitting stale.
  useEffect(() => {
    const timer = setInterval(() => void reload(), 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  // Belt-and-braces against a missed remount: `key={detail.project.id}` on
  // the component already resets all of this per project; this clears the
  // previous project's view even if that remount ever regresses.
  useEffect(() => {
    setView(null);
    setStartError(null);
    setViewFailed(false);
  }, [projectId]);

  return {
    view,
    resolved: view !== null,
    openingFailed: startError !== null || viewFailed,
    startError,
    retryOpening,
    refreshingAfterAction,
    refresh,
    reload,
    markStage,
  };
}
