/**
 * Project state, folded from a run's own committed workflow events.
 *
 * Where a project's lifecycle run stands is never held in process memory: it
 * is derived here, from the events the run itself committed, the same way on
 * the hub (`apps/hub/src/hub-executor.ts`, which fetches the events) and,
 * eventually, on the client (through `@intx/hub-client`, which fetches the
 * same events over the loopback API). Keeping the fold in the app package
 * means both readers apply the identical rule rather than two copies of it
 * drifting apart.
 */
import { applyEvent, emptyState, type RunState } from "@intx/workflow";
import { stageOfStepId } from "./workflows/stage-loop.js";
import type { Stage } from "./ledger.js";

/**
 * The minimal shape this module needs from a committed run event. The hub
 * stores the discriminator as `type`; the runtime reads it as `kind` — that
 * translation happens once, here, rather than in every caller.
 */
export type RunEvent = {
  readonly seq: number;
  readonly type: string;
  readonly body: Record<string, unknown>;
};

export type FoldedRun = {
  readonly runId: string;
  readonly state: RunState;
  /** When the run's newest event was committed, or null for a run with none. */
  readonly lastAt: number | null;
  /** When each step's latest attempt started, by step id: how long a step has been at it. */
  readonly stepStartedAt: ReadonlyMap<string, number>;
};

/** Folds one run's committed events into its current state. */
export function foldRun(runId: string, events: readonly RunEvent[]): FoldedRun {
  let state = emptyState(runId);
  let lastAt: number | null = null;
  const stepStartedAt = new Map<string, number>();
  for (const event of events) {
    state = applyEvent(state, { ...event.body, seq: event.seq, kind: event.type } as unknown as Parameters<
      typeof applyEvent
    >[1]);
    const at = typeof event.body.at === "string" ? Date.parse(event.body.at) : Number.NaN;
    if (!Number.isNaN(at) && (lastAt === null || at > lastAt)) lastAt = at;
    if (event.type === "StepStarted" && !Number.isNaN(at) && typeof event.body.stepId === "string") {
      stepStartedAt.set(event.body.stepId, at);
    }
  }
  return { runId, state, lastAt, stepStartedAt };
}

export type Parked = {
  readonly runId: string;
  readonly stepId: string;
  readonly stage: Stage;
  readonly signalName: string | null;
  readonly since: string | null;
};

/** When a step's latest attempt started, as the hub recorded it, or null when it never started. */
function sinceOf(run: FoldedRun, stepId: string): string | null {
  const at = run.stepStartedAt.get(stepId);
  return at === undefined ? null : new Date(at).toISOString();
}

/**
 * The steps waiting on a person. Every gate lives on the top-level run: a
 * stage's revise loop awaits its round signal through the loop's relay, and
 * its gate awaits the approve signal directly. Both step ids carry the stage.
 * A loop iteration's own run also parks on the round signal; it reports under
 * the loop step that spawned it.
 */
export function parkedSteps(runs: readonly FoldedRun[]): Parked[] {
  const spawnedBy = new Map<string, string>();
  for (const run of runs) {
    for (const [childRunId, child] of run.state.children) spawnedBy.set(childRunId, child.spawnedBy);
  }
  const parked: Parked[] = [];
  for (const run of runs) {
    for (const step of run.state.steps.values()) {
      if (step.phase !== "awaiting-signal") continue;
      const stepId = spawnedBy.get(run.runId) ?? step.stepId;
      const stage = stageOfStepId(stepId);
      if (stage === null) continue;
      parked.push({
        runId: run.runId,
        stepId,
        stage,
        signalName: step.awaitingSignal?.name ?? null,
        since: sinceOf(run, step.stepId),
      });
    }
  }
  return parked;
}

/** The top-level stage step currently running, when nothing is parked. */
export function currentStep(runs: readonly FoldedRun[]): { stepId: string; stage: Stage; since: string | null } | null {
  for (const run of runs) {
    for (const step of run.state.steps.values()) {
      const stage = stageOfStepId(step.stepId);
      if (step.phase === "in-flight" && stage !== null) return { stepId: step.stepId, stage, since: sinceOf(run, step.stepId) };
    }
  }
  return null;
}

/** The run phases nothing follows (`isTerminalRunPhase` in the runtime's state machine). */
export const ENDED = new Set(["completed", "failed", "cancelled"]);

/**
 * How long a fired run may sit with nothing parked and nothing in flight
 * before it is taken to have died without a trace. A run that crashes in
 * the sidecar's own process can leave the hub's log with no terminal event
 * at all; folded, it reads as running, and it never moves again.
 */
const STALLED_AFTER_MS = 60_000;

/**
 * The deployment has fired its lifecycle run and nothing on it will ever
 * park again: every run under it has ended, or the runs sit with nothing
 * parked and nothing in flight and their newest event is old, or a stage
 * step on the lifecycle run itself has failed. The deployment itself stays
 * allocated when its run fails, so its allocation status cannot say this;
 * only the runs can. (A deployment with no runs yet is not dead — it has
 * not been fired.)
 *
 * The failed stage step is the case a restart used to be the only way out
 * of: a signal landing inside the runtime's own commit fails the stage's
 * loop, the runtime routes on to the stage's gates, and those park but
 * never complete. Folded, the run reads as parked, so a caller that only
 * checked for a parked step kept signalling a run that could not move.
 */
export function anchorIsDead(anchor: string, runs: readonly FoldedRun[]): boolean {
  if (runs.length === 0) return false;
  if (runs.every((run) => ENDED.has(run.state.phase))) return true;
  const lifecycle = runs.find((run) => run.runId === anchor);
  if (lifecycle && [...lifecycle.state.steps.values()].some((step) => step.phase === "failed" && stageOfStepId(step.stepId) !== null)) {
    return true;
  }
  if (parkedSteps(runs).length > 0 || currentStep(runs) !== null) return false;
  const newest = Math.max(...runs.map((run) => run.lastAt ?? 0));
  return newest > 0 && Date.now() - newest > STALLED_AFTER_MS;
}

export type StageStatus = {
  readonly stage: Stage;
  readonly stepId: string;
  readonly parked: boolean;
  readonly signalName: string | null;
  /** When the step began — running, or waiting — so a window can count from it. */
  readonly since: string | null;
};

/** Where a project's run stands, read from its own folded runs. */
export function projectState(runs: readonly FoldedRun[]): StageStatus | null {
  const [parked] = parkedSteps(runs);
  if (parked) return { stage: parked.stage, stepId: parked.stepId, parked: true, signalName: parked.signalName, since: parked.since };
  const running = currentStep(runs);
  if (running) return { ...running, parked: false, signalName: null };
  return null;
}
