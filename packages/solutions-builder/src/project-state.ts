/**
 * Project state, folded from a run's own committed workflow events.
 *
 * Where a project's lifecycle run stands is never held in process memory: it
 * is derived here, from the events the run itself committed, the same way on
 * the hub (`apps/hub/src/lifecycle-run.ts`, which fetches the events) and,
 * eventually, on the client (through `@intx/hub-client`, which fetches the
 * same events over the loopback API). Keeping the fold in the app package
 * means both readers apply the identical rule rather than two copies of it
 * drifting apart.
 */
import { applyEvent, emptyState, type RunState } from "@intx/workflow";
import { stageOfSignal, stageOfStepId } from "./workflows/stage-loop.js";
import { NAME_STEP_ID } from "./workflows/project-lifecycle.js";
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

/** One decision a gate signal carried, as committed on the run — no ledger turn behind it. */
export type FoldedApproval = {
  readonly runId: string;
  readonly stage: Stage;
  readonly command: string;
  readonly decision: string;
  readonly audienceName: string | null;
  readonly rationale: string | null;
  readonly at: string | null;
  readonly versions: { versionId: string; contentHash: string }[];
};

/** One decision flag a gate signal raised, as committed on the run. */
export type FoldedFlag = {
  readonly runId: string;
  readonly id: string;
  readonly trigger: string;
  readonly classification: string;
  readonly evidence: unknown;
  readonly chosenRoute: number | null;
  readonly rejectedRoutes: unknown;
  readonly at: string | null;
};

/** One worker question a run raised, joined to its answer once one lands. */
export type FoldedQuestion = {
  readonly runId: string;
  readonly id: string;
  readonly originId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly scopeImpact: unknown;
  readonly at: string | null;
  readonly answer: { readonly answer: string; readonly grantedCapabilities: unknown; readonly at: string | null } | null;
};

export type FoldedRun = {
  readonly runId: string;
  readonly state: RunState;
  /** When the run's newest event was committed, or null for a run with none. */
  readonly lastAt: number | null;
  /** When each step's latest attempt started, by step id: how long a step has been at it. */
  readonly stepStartedAt: ReadonlyMap<string, number>;
  /** Every gate decision this run's committed signals carried, oldest first. */
  readonly approvals: readonly FoldedApproval[];
  /** Every decision flag this run's committed signals raised, oldest first. */
  readonly flags: readonly FoldedFlag[];
  /** Every worker question this run raised, oldest first, joined to its answer. */
  readonly questions: readonly FoldedQuestion[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Folds one run's committed events into its current state. */
export function foldRun(runId: string, events: readonly RunEvent[]): FoldedRun {
  let state = emptyState(runId);
  let lastAt: number | null = null;
  const stepStartedAt = new Map<string, number>();
  const approvals: FoldedApproval[] = [];
  const flags: FoldedFlag[] = [];
  const questions: FoldedQuestion[] = [];
  const answers = new Map<string, { answer: string; grantedCapabilities: unknown; at: string | null }>();
  for (const event of events) {
    state = applyEvent(state, { ...event.body, seq: event.seq, kind: event.type } as unknown as Parameters<
      typeof applyEvent
    >[1]);
    const at = typeof event.body.at === "string" ? Date.parse(event.body.at) : Number.NaN;
    const atIso = typeof event.body.at === "string" ? event.body.at : null;
    if (!Number.isNaN(at) && (lastAt === null || at > lastAt)) lastAt = at;
    if (event.type === "StepStarted" && !Number.isNaN(at) && typeof event.body.stepId === "string") {
      stepStartedAt.set(event.body.stepId, at);
    }
    if (event.type !== "SignalReceived") continue;
    const payload = asRecord(event.body.payload);
    if (!payload) continue;
    const command = typeof payload.command === "string" ? payload.command : null;
    if (!command) continue;
    const signalName = typeof event.body.signalName === "string" ? event.body.signalName : "";
    const stage = stageOfSignal(signalName);
    if (typeof payload.decision === "string" && stage !== null) {
      approvals.push({
        runId,
        stage,
        command,
        decision: payload.decision,
        audienceName: typeof payload.audienceName === "string" ? payload.audienceName : null,
        rationale: typeof payload.rationale === "string" ? payload.rationale : null,
        at: atIso,
        versions: Array.isArray(payload.versions)
          ? (payload.versions as { versionId: string; contentHash: string }[])
          : [],
      });
    }
    const flag = asRecord(payload.flag);
    if (flag) {
      flags.push({
        runId,
        id: String(flag.id ?? ""),
        trigger: String(flag.trigger ?? ""),
        classification: String(flag.classification ?? ""),
        evidence: flag.evidence,
        chosenRoute: typeof flag.chosenRoute === "number" ? flag.chosenRoute : null,
        rejectedRoutes: flag.rejectedRoutes,
        at: atIso,
      });
    }
    const answer = asRecord(payload.answer);
    if (answer && typeof answer.questionId === "string") {
      answers.set(answer.questionId, {
        answer: String(answer.answer ?? ""),
        grantedCapabilities: answer.grantedCapabilities,
        at: atIso,
      });
    }
    const question = asRecord(payload.question);
    if (question) {
      questions.push({
        runId,
        id: String(question.id ?? ""),
        originId: String(question.originId ?? ""),
        kind: String(question.kind ?? ""),
        prompt: String(question.prompt ?? ""),
        scopeImpact: question.scopeImpact,
        at: atIso,
        answer: null,
      });
    }
  }
  return {
    runId,
    state,
    lastAt,
    stepStartedAt,
    approvals,
    flags,
    questions: questions.map((question) => ({ ...question, answer: answers.get(question.id) ?? null })),
  };
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

// A step's output rides its `StepCompleted` event as a substrate ref: values
// small enough to inline (everything this fold cares about) carry the
// JSON-encoded payload verbatim after this prefix; anything larger spills to
// a blob this fold does not read back.
const INLINE_OUTPUT_PREFIX = "inline:";

/**
 * The namer agent step's completed output on one run, resolved from its
 * inline ref. The step's output is the agent's raw reply (`{ reply: "..." }`,
 * the same shape every agent step's output takes), so the title is its
 * `reply` field trimmed. Null when the step has not completed on this run,
 * or its output did not land inline (a title is always a few words, so this
 * is not expected in practice).
 */
function namedTitle(run: FoldedRun): string | null {
  const step = run.state.steps.get(NAME_STEP_ID);
  if (step?.phase !== "completed" || step.outputRef === undefined) return null;
  if (!step.outputRef.startsWith(INLINE_OUTPUT_PREFIX)) return null;
  let output: unknown;
  try {
    output = JSON.parse(step.outputRef.slice(INLINE_OUTPUT_PREFIX.length));
  } catch {
    return null;
  }
  const reply =
    output !== null && typeof output === "object" && "reply" in output
      ? (output as { reply: unknown }).reply
      : undefined;
  const title = typeof reply === "string" ? reply.trim() : "";
  return title.length > 0 ? title : null;
}

/**
 * The project's real title, folded from the namer agent step's committed
 * output once it completes on any of the project's runs. Null until then --
 * callers fall back to the tenant name or the trimmed problem statement.
 */
export function projectTitle(runs: readonly FoldedRun[]): string | null {
  for (const run of runs) {
    const title = namedTitle(run);
    if (title !== null) return title;
  }
  return null;
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

/** Every gate decision recorded across a project's runs, oldest first. */
export function projectApprovals(runs: readonly FoldedRun[]): FoldedApproval[] {
  return runs.flatMap((run) => run.approvals);
}

/** Every decision flag raised across a project's runs, oldest first. */
export function projectFlags(runs: readonly FoldedRun[]): FoldedFlag[] {
  return runs.flatMap((run) => run.flags);
}

/** Every worker question raised across a project's runs, oldest first, each joined to its answer. */
export function projectQuestions(runs: readonly FoldedRun[]): FoldedQuestion[] {
  return runs.flatMap((run) => run.questions);
}

/** The newest unanswered worker question on a run, if any. */
export function openQuestion(runs: readonly FoldedRun[], runId: string): FoldedQuestion | undefined {
  return projectQuestions(runs)
    .filter((question) => question.runId === runId && question.answer === null)
    .at(-1);
}
