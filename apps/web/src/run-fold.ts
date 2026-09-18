/**
 * Where a project's lifecycle run stands, folded in the browser.
 *
 * `GET /projects/:id` is the ledger, artifacts, and the tenant/anchor this
 * fold addresses. Standing itself is this read: the same events the run
 * committed, over `/hub`, through the app package's fold. Ledger writes stay
 * on the host.
 *
 * Lifecycle v4 (CL-8598): a stage is no longer a bounded revise/gate loop.
 * The whole approve chain — `gate-1`..`gate-8`, `freeze`, `evidence` — lives
 * as top-level `awaitSignal` steps directly on the anchor run, in that fixed
 * order (`gate-7` -> `freeze` -> `evidence` -> `gate-8`), followed by the
 * stage-9 `delivery-check` agent step. Standing is read straight off those
 * step phases: no round/exhausted/cap folding, no loop child runs to walk.
 */
import { listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import {
  foldRun,
  feedbackForDesign,
  projectApprovals,
  projectFeedback,
  projectFlags,
  projectQuestions,
  projectTitle,
  type FoldedApproval,
  type FoldedFeedback,
  type FoldedFlag,
  type FoldedQuestion,
  type FoldedRun,
} from "@solutions-builder/app/project-state";
import { openingFromTrigger } from "@solutions-builder/app/trigger-envelope";
import type { Stage } from "@solutions-builder/app/ledger";
import { createHubTransport } from "./hub.ts";

export type { FoldedApproval, FoldedFeedback, FoldedFlag, FoldedQuestion, FoldedRun };
export { feedbackForDesign, projectApprovals, projectFeedback, projectFlags, projectQuestions, projectTitle };

/** Where a project's run stands: the top-level approve-chain step it is at. */
export type StageStatus = {
  readonly stage: Stage;
  /** The top-level step id standing for this position: a `gate-N`, `freeze`,
   * `evidence` or `delivery-check` once the run has reached it, or `"chat"`
   * while the chat section is still drafting the stage ahead of its gate. */
  readonly stepId: string;
  /** True once the run is parked at a gate awaiting a person's signal. */
  readonly parked: boolean;
  readonly signalName: string | null;
  /** When the step began — running, or waiting — so a window can count from it. */
  readonly since: string | null;
};

/**
 * The approve chain's top-level steps, in the fixed order the definition
 * wires them: `gate-1`..`gate-7`, then `freeze` and `evidence` between
 * `gate-7` and `gate-8` (cost approved -> frozen into a build -> its
 * evidence hand-off), then `gate-8`, then stage 9's `delivery-check`.
 */
const POSITION_STEPS = [
  "gate-1",
  "gate-2",
  "gate-3",
  "gate-4",
  "gate-5",
  "gate-6",
  "gate-7",
  "freeze",
  "evidence",
  "gate-8",
  "delivery-check",
] as const;

/** The stage a position step stands for. */
function stageOfPositionStep(stepId: string): Stage {
  if (stepId === "freeze") return 7 as Stage;
  if (stepId === "evidence") return 8 as Stage;
  if (stepId === "delivery-check") return 9 as Stage;
  const match = /^gate-(\d)$/.exec(stepId);
  return match ? (Number(match[1]) as Stage) : (1 as Stage);
}

/** When a step's latest attempt started, as the hub recorded it, or null when it never started. */
function sinceOf(run: FoldedRun, stepId: string): string | null {
  const at = run.stepStartedAt.get(stepId);
  return at === undefined ? null : new Date(at).toISOString();
}

/**
 * Where the anchor run stands, read off the approve chain's own step phases:
 * the first `POSITION_STEPS` entry that has not completed is the frontier.
 * Parked (awaiting its signal) means at that gate; in flight (`delivery-check`
 * drafting) or not started yet (the chat section still drafting the stage
 * ahead of its gate) both mean in progress. Null once `delivery-check` has
 * completed: there is nothing left to stand on.
 */
function anchorPosition(run: FoldedRun): StageStatus | null {
  let lastCompletedIndex = -1;
  for (let index = 0; index < POSITION_STEPS.length; index += 1) {
    if (run.state.steps.get(POSITION_STEPS[index]!)?.phase === "completed") lastCompletedIndex = index;
  }
  const currentIndex = lastCompletedIndex + 1;
  if (currentIndex >= POSITION_STEPS.length) return null;
  const stepId = POSITION_STEPS[currentIndex]!;
  const stage = stageOfPositionStep(stepId);
  const step = run.state.steps.get(stepId);
  if (step?.phase === "awaiting-signal") {
    return { stage, stepId, parked: true, signalName: step.awaitingSignal?.name ?? null, since: sinceOf(run, stepId) };
  }
  if (step?.phase === "in-flight") {
    return { stage, stepId, parked: false, signalName: null, since: sinceOf(run, stepId) };
  }
  return { stage, stepId: "chat", parked: false, signalName: null, since: null };
}

/** Where the anchor run stands, picked out of an already-folded run list. */
export function positionFromRuns(runs: readonly FoldedRun[], anchorRunId: string): StageStatus | null {
  const anchor = runs.find((run) => run.runId === anchorRunId);
  return anchor ? anchorPosition(anchor) : null;
}

/** Every run under the deployment, folded from its committed `/hub` events. */
export async function foldProjectRuns(
  tenantId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<FoldedRun[]> {
  const runIds = await listWorkflowRuns(transport, tenantId, anchorRunId);
  const folded: FoldedRun[] = [];
  for (const runId of runIds) {
    const { events } = await readWorkflowRunEvents(transport, tenantId, anchorRunId, runId);
    folded.push(foldRun(runId, events));
  }
  return folded;
}

/** Where the project's run stands, read from `/hub` events. */
export async function foldProject(
  tenantId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<StageStatus | null> {
  const runs = await foldProjectRuns(tenantId, anchorRunId, transport);
  return positionFromRuns(runs, anchorRunId);
}

/**
 * Where the project's run stands, and its real title once the namer step's
 * output has folded, from a single pass over `/hub` events.
 */
export async function foldProjectStanding(
  tenantId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<{ status: StageStatus | null; title: string | null }> {
  const runs = await foldProjectRuns(tenantId, anchorRunId, transport);
  return { status: positionFromRuns(runs, anchorRunId), title: projectTitle(runs) };
}

/**
 * Standing for a project GET: fold the hub events the tenant/anchor name.
 * No anchor means the lifecycle is not placed yet, so there is nothing to fold.
 */
export async function standingForProject(
  project: { tenantId: string; anchorRunId: string | null },
  transport: Transport = createHubTransport(),
): Promise<StageStatus | null> {
  if (project.anchorRunId === null) return null;
  return foldProject(project.tenantId, project.anchorRunId, transport);
}

/** A stage step is in flight — the model is writing, not waiting at a gate. */
export function runIsDrafting(standing: StageStatus | null): boolean {
  return standing !== null && standing.parked === false;
}

/**
 * The stage-1 opening problem statement, read off the anchor run's own
 * `RunStarted` event rather than the ledger (`ProjectDetail.opening` used
 * to ride the `GET /projects/:id` read) — the run's trigger payload carries
 * the same `{ projectId, problemStatement }` `client.ts`'s `createProject`
 * fires the deployment with, so it needs no host record of its own.
 *
 * The trigger fires through a signed conversation message, so `trigger.payload`
 * on the event is the mail envelope the hub wraps that content in, not the
 * flat object directly — `openingFromTrigger` unwraps either shape.
 */
export async function foldOpening(
  tenantId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<{ body: string; createdAt: string } | null> {
  const { events } = await readWorkflowRunEvents(transport, tenantId, anchorRunId, anchorRunId);
  const started = events.find((event) => event.type === "RunStarted");
  if (!started) return null;
  const trigger = started.body.trigger as { payload?: unknown } | undefined;
  const opening = openingFromTrigger(trigger?.payload);
  if (!opening) return null;
  const createdAt = typeof started.body.at === "string" ? started.body.at : new Date().toISOString();
  return { body: opening.problemStatement, createdAt };
}
