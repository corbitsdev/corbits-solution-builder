/**
 * The project lifecycle, running on the hub.
 *
 * Each project has its own deployment of the generated lifecycle
 * (`workflow-deploy.ts`); the hub places it on Interchange's own sidecar and
 * the sidecar runs it. This module is the thin client: it fires the
 * deployment's top-level run, delivers the ledger's gate commands as signals,
 * and reads where the run stands by folding the run's own committed events.
 * Nothing here executes a workflow; that is the sidecar's job.
 *
 * The product's own run record (origin, source, cost approval, packet,
 * checkpoint, why it ended) is folded from the ledger thread in `runs.ts`;
 * nothing about a run lives in process memory.
 */
import { ApiError } from "@intx/hub-client";
import { applyEvent, emptyState, loopBodyRunId, type WorkflowEvent } from "@intx/workflow";
import type { Command, Stage } from "@solutions-builder/app/ledger";
import {
  alignmentStep,
  exhaustedSignal,
  positionOfSignal,
  reviseStepId,
  stageOfStepId,
  stageSignal,
  type LedgerPosition,
  type StageSignal,
} from "@solutions-builder/app/workflows/stage-loop";
import { assets, deploymentRuns, HubApiError, workflows, type HubRunEvent } from "./hub-client.js";
import {
  deploymentIsLive,
  ensureLifecycleDeployment,
  lifecycleAssetName,
  type LifecycleDeployment,
} from "./installer-bridge.js";

/** What a signal delivery actually did, so a caller can tell nothing from broken. */
export type DeliveryOutcome = "delivered" | "no_execution" | "failed";

/** Why a project has no execution: no model provider connected, or no host to place a sidecar on. */
export type ExecutionUnavailableReason = Extract<LifecycleDeployment["status"], "no_offering" | "no_host">;

// --- The deployment behind a project -------------------------------------------

/** Anchor run id (= deployment id) per project, remembered once resolved. */
const anchors = new Map<string, string>();
/** Why a project has no execution, for the status line. */
const unavailable = new Map<string, ExecutionUnavailableReason>();

async function anchorFor(projectId: string, replace = false): Promise<string | null> {
  const known = anchors.get(projectId);
  if (known && !replace) return known;
  const deployment = await ensureLifecycleDeployment(projectId, { replace });
  if (deployment.status === "no_offering" || deployment.status === "no_host") {
    unavailable.set(projectId, deployment.status);
    return null;
  }
  unavailable.delete(projectId);
  anchors.set(projectId, deployment.deploymentId);
  return deployment.deploymentId;
}

/**
 * The project whose lifecycle a run belongs to, by the run's id: a loop
 * iteration's id is its anchor's followed by `__`, and an anchor is a
 * deployment of one project's lifecycle asset. Null for a run that is not a
 * project's.
 */
export async function projectForRun(runId: string): Promise<string | null> {
  const anchor = runId.split("__")[0] ?? runId;
  for (const [projectId, known] of anchors) if (known === anchor) return projectId;
  const deployment = (await workflows.deployments()).find((entry) => entry.id === anchor);
  if (!deployment) return null;
  const asset = (await assets.list("workflow")).find((entry) => entry.id === deployment.definitionAssetId);
  const match = asset ? /^solutions-builder-project-lifecycle-tnt-([a-z0-9]+)$/.exec(asset.name) : null;
  return match ? `tnt_${match[1]}` : null;
}

/**
 * Every anchor the project's lifecycle has run under, oldest first: one per
 * deployment of its asset. Stopping the host releases the sidecar, so each
 * start deploys the lifecycle again under a new anchor and aligns it to
 * where the ledger stands; the rounds a stage recorded before that are
 * under the earlier anchors, and they are still the stage's conversation.
 * Read once per process, then extended as the current anchor changes: a
 * deployment that is not the current one gains no runs after this host
 * started.
 */
const anchorHistory = new Map<string, string[]>();

async function anchorsFor(projectId: string): Promise<string[]> {
  const current = anchors.get(projectId) ?? (await anchorFor(projectId));
  let history = anchorHistory.get(projectId);
  if (!history) {
    const name = lifecycleAssetName(projectId);
    const asset = (await assets.list("workflow")).find((entry) => entry.name === name);
    history = asset
      ? (await workflows.deployments())
          .filter((deployment) => deployment.definitionAssetId === asset.id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((deployment) => deployment.id)
      : [];
    anchorHistory.set(projectId, history);
  }
  if (current && !history.includes(current)) history.push(current);
  return history;
}

/** The run ids under an anchor that is no longer current. Those never change, so they are read once. */
const settledRunIds = new Map<string, string[]>();

async function runIdsUnder(anchor: string, current: boolean): Promise<string[]> {
  if (current) return deploymentRuns.list(anchor);
  const known = settledRunIds.get(anchor);
  if (known) return known;
  const listed = await deploymentRuns.list(anchor);
  settledRunIds.set(anchor, listed);
  return listed;
}

type FoldedRun = {
  readonly runId: string;
  readonly state: ReturnType<typeof emptyState>;
  /** When the run's newest event was committed, or null for a run with none. */
  readonly lastAt: number | null;
  /** When each step's latest attempt started, by step id: how long a step has been at it. */
  readonly stepStartedAt: ReadonlyMap<string, number>;
};

/** Every run under the deployment, folded from its committed events. */
async function foldRuns(anchorRunId: string): Promise<FoldedRun[]> {
  const runIds = await deploymentRuns.list(anchorRunId);
  const folded: FoldedRun[] = [];
  for (const runId of runIds) {
    const events = await deploymentRuns.events(anchorRunId, runId);
    let state = emptyState(runId);
    let lastAt: number | null = null;
    const stepStartedAt = new Map<string, number>();
    for (const event of events) {
      // The hub stores the discriminator as `type`; the runtime reads it as
      // `kind`. The stored body already carries `seq` and `type`.
      state = applyEvent(state, { ...event.body, seq: event.seq, kind: event.type } as unknown as WorkflowEvent);
      const at = typeof event.body.at === "string" ? Date.parse(event.body.at) : Number.NaN;
      if (!Number.isNaN(at) && (lastAt === null || at > lastAt)) lastAt = at;
      if (event.type === "StepStarted" && !Number.isNaN(at) && typeof event.body.stepId === "string") {
        stepStartedAt.set(event.body.stepId, at);
      }
    }
    folded.push({ runId, state, lastAt, stepStartedAt });
  }
  return folded;
}

type Parked = {
  readonly runId: string;
  readonly stepId: string;
  readonly stage: Stage;
  readonly signalName: string | null;
  readonly since: string | null;
};

/**
 * The steps waiting on a person. Every gate lives on the top-level run: a
 * stage's revise loop awaits its round signal through the loop's relay, and
 * its gate awaits the approve signal directly. Both step ids carry the stage.
 * A loop iteration's own run also parks on the round signal; it reports under
 * the loop step that spawned it.
 */
function parkedSteps(runs: FoldedRun[]): Parked[] {
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

/** When a step's latest attempt started, as the hub recorded it, or null when it never started. */
function sinceOf(run: FoldedRun, stepId: string): string | null {
  const at = run.stepStartedAt.get(stepId);
  return at === undefined ? null : new Date(at).toISOString();
}

/** The top-level stage step currently running, when nothing is parked. */
function currentStep(runs: FoldedRun[]): { stepId: string; stage: Stage; since: string | null } | null {
  for (const run of runs) {
    for (const step of run.state.steps.values()) {
      const stage = stageOfStepId(step.stepId);
      if (step.phase === "in-flight" && stage !== null) return { stepId: step.stepId, stage, since: sinceOf(run, step.stepId) };
    }
  }
  return null;
}

/**
 * Fires the project's lifecycle on its deployment. Idempotent: a deployment
 * whose top-level run already has events is left alone, and the hub itself
 * refuses to fire a terminal run twice.
 */
export async function launchProjectLifecycle(args: { readonly projectId: string }): Promise<void> {
  const anchor = await anchorFor(args.projectId);
  if (!anchor) return;
  const runIds = await deploymentRuns.list(anchor);
  if (runIds.length > 0) return;
  await deploymentRuns.trigger(anchor, JSON.stringify({ projectId: args.projectId }));
}

export type StageStatus = {
  readonly stage: Stage;
  readonly stepId: string;
  readonly parked: boolean;
  readonly signalName: string | null;
  /** When the step began — running, or waiting — so a window can count from it. */
  readonly since: string | null;
};

/** Where the project's run stands, read from the hub's own event log. */
export async function projectExecutionStatus(projectId: string): Promise<StageStatus | null> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return null;
  const runs = await foldRuns(anchor);
  const [parked] = parkedSteps(runs);
  if (parked) return { stage: parked.stage, stepId: parked.stepId, parked: true, signalName: parked.signalName, since: parked.since };
  const running = currentStep(runs);
  if (running) return { ...running, parked: false, signalName: null };
  return null;
}

/**
 * Delivers a gate command as the signal the parked stage waits on. Refused
 * as `no_execution` when nothing awaits that name, so a command the ledger
 * accepted but the run cannot consume is visible rather than swallowed. `signalId` is the command's own idempotency key, so a retried
 * command is a deduplicated signal, never a second one.
 */
/**
 * How long a delivery waits for the run to park between steps. A round that
 * has just finished leaves the loop spawning its next iteration for a moment;
 * a command that arrives in that gap must not read as "nothing awaits it".
 */
const PARK_WAIT_MS = 20_000;

/**
 * The signal the run currently awaits for this command, waiting out the gap
 * between one step ending and the next park while a stage step is in flight.
 * The command lands on whichever stage the run is parked at; the ledger has
 * already decided it is allowed there.
 */
async function awaitingSignalFor(anchor: string, command: Command, expectedStage?: Stage): Promise<StageSignal | null> {
  const deadline = Date.now() + PARK_WAIT_MS;
  for (;;) {
    const runs = await foldRuns(anchor);
    const signal = parkedSteps(runs)
      // A command is for the stage the ledger acted on. Delivered to whatever
      // stage happens to be parked, a stage-5 draft would run stage 1's
      // specialist with stage 5's prompt; better nothing than that.
      .filter((step) => expectedStage === undefined || step.stage === expectedStage)
      .flatMap((step) => [stageSignal(step.stage, command, "gate"), stageSignal(step.stage, command, "exhausted")]
        .map((candidate) => ({ step, signal: candidate })))
      .find(({ step, signal }) => step.signalName === signal.name)?.signal;
    if (signal) return signal;
    if (currentStep(runs) === null || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function deliverStageSignal(
  projectId: string,
  command: Command,
  payload: Record<string, unknown> = {},
  signalId: string = crypto.randomUUID(),
  expectedStage?: Stage,
): Promise<DeliveryOutcome> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return "no_execution";
  const signal = await awaitingSignalFor(anchor, command, expectedStage);
  if (!signal) return "no_execution";
  // Signals address the deployment's top-level run; a loop relays a named
  // signal into the iteration that awaits it.
  try {
    await deploymentRuns.signal(anchor, {
      runId: anchor,
      signalName: signal.name,
      signalId,
      payload: { ...payload, ...signal.payload },
    });
    divergent.delete(projectId);
    return "delivered";
  } catch (cause) {
    // Only a refusal the transport actually reported — an `ApiError` off a
    // non-2xx response — reads as a refused signal. Anything else (a
    // programming error, a failure the transport did not translate) is not
    // this function's to swallow, and propagates.
    if (!(cause instanceof ApiError)) throw cause;
    console.error(
      `[executor] ${projectId}: the hub did not accept ${signal.name} (${cause.status}) ${cause.message}; ` +
        `the ledger has moved and the run has not.`,
    );
    divergent.add(projectId);
    return "failed";
  }
}

/**
 * How long a freshly fired run gets to park for the first time. A new
 * deployment materialises the lifecycle's closure and starts a sidecar
 * before its run can take a step, and on a slow disk that has taken well
 * over half a minute.
 */
const FIRST_PARK_WAIT_MS = 180_000;

/** Waits until `step` is no longer parked on its signal, or the park wait runs out. */
async function consumed(anchor: string, step: Parked): Promise<void> {
  const deadline = Date.now() + PARK_WAIT_MS;
  while (Date.now() < deadline) {
    const still = parkedSteps(await foldRuns(anchor)).some(
      (candidate) =>
        candidate.runId === step.runId && candidate.stepId === step.stepId && candidate.signalName === step.signalName,
    );
    if (!still) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * A pause after every signal the executor sends on a person's behalf. The
 * runtime commits its own events to the run's log as a step ends and the
 * next one starts; a signal landing inside that commit has been seen to
 * collide with it (two events at one sequence number), which fails the
 * whole run. Waiting for the next park is not enough on its own, since the
 * park is written before the commit that follows it settles.
 */
const SETTLE_MS = 750;

/** The run phases nothing follows (`isTerminalRunPhase` in the runtime's state machine). */
const ENDED = new Set(["completed", "failed", "cancelled"]);

/**
 * How long a fired run may sit with nothing parked and nothing in flight
 * before it is taken to have died without a trace. A run that crashes in
 * the sidecar's own process can leave the hub's log with no terminal event
 * at all; folded, it reads as running, and it never moves again.
 */
const STALLED_AFTER_MS = 60_000;

/** How often the wait for a park re-reads whether the deployment is still live. */
const LIVENESS_CHECK_MS = 2_000;

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
 * never complete. Folded, the run reads as parked, so the executor kept
 * signalling a run that could not move.
 */
function anchorIsDead(anchor: string, runs: FoldedRun[]): boolean {
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

/**
 * The first parked stage step with a position this module knows, waiting for
 * a run that is still starting. "dead" when the run has ended instead — a run
 * that failed leaves nothing parked, and waiting for it would only time out.
 */
async function parkedPosition(anchor: string, waitMs: number): Promise<Parked | "dead" | null> {
  const deadline = Date.now() + waitMs;
  let checkLiveAt = 0;
  for (;;) {
    // The platform gives up on a sidecar that never dials back in and
    // releases the deployment under the run; nothing sent to it since was
    // delivered, and nothing will be. Read that as dead as soon as it lands
    // rather than after the full wait.
    if (Date.now() >= checkLiveAt) {
      checkLiveAt = Date.now() + LIVENESS_CHECK_MS;
      if (!(await deploymentIsLive(anchor))) return "dead";
    }
    const runs = await foldRuns(anchor);
    if (anchorIsDead(anchor, runs)) return "dead";
    const parked = parkedSteps(runs).find(
      (step) => step.signalName !== null && positionOfSignal(step.stage, step.signalName) !== null,
    );
    if (parked) return parked;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Brings the project's run to where the ledger says the project stands.
 *
 * A run can fall behind the ledger: a project drafted before the specialists
 * lived in the run, or whose deployment was re-rendered, gets a fresh run
 * that starts at stage 1 while the ledger is at stage 5. The ledger is the
 * state machine, so the run is walked forward to it with the signals a person
 * would have sent, one stage at a time (`alignmentStep`), and nothing is
 * delivered to a stage the ledger has already left. Fires the run first when
 * the deployment has none, which is also what a restart needs.
 *
 * "aligned" when the run is parked where the ledger is; "no_execution" when
 * there is no deployment to align; "failed" when the run could not be brought
 * there, with the reason logged — the command that follows then reads as
 * undeliverable rather than landing on the wrong stage.
 */
/** How many fresh deployments the alignment will try when each one's run dies under it. */
const REPLACEMENTS = 3;

export async function alignRunWithLedger(projectId: string, ledger: LedgerPosition): Promise<"aligned" | "no_execution" | "failed"> {
  for (let replaced = 0; ; replaced += 1) {
    try {
      return await alignOnce(projectId, ledger);
    } catch (cause) {
      // The anchor this process remembered is dead: its sidecar was released
      // under it, or its run failed. Forget it and resolve the deployment
      // again, which deploys a live one, then try again; anything else is
      // the failure it was. The replacement's own run can die the same way
      // while it is walked to the ledger, so this is a bounded loop rather
      // than one more try.
      const conflict = (cause instanceof HubApiError || cause instanceof ApiError) && cause.status === 409;
      if (!conflict || replaced >= REPLACEMENTS) throw cause;
      console.error(`[executor] ${projectId}: the run's deployment is no longer live; deploying the lifecycle again.`);
      forgetExecution(projectId);
      // A replacement, not a re-resolution: a dead run leaves its deployment
      // allocated and its digest current, so resolving again would hand the
      // same dead anchor back.
      if ((await anchorFor(projectId, true)) === null) return "no_execution";
    }
  }
}

/**
 * Forgets the deployment this process resolved for a project, so the next
 * command resolves it again: a fresh deployment when the rendered lifecycle
 * changed (a stakeholder added), or when the old one is dead.
 */
export function forgetExecution(projectId: string): void {
  anchors.delete(projectId);
}

/**
 * Forgets every project's deployment. The lifecycle is rendered with the
 * model it will draft with, pinned at deploy time, so a change to what the
 * catalog serves — a model chosen, providers reordered, one connected or
 * disconnected — is a different lifecycle. The next command on any project
 * resolves its deployment again, which deploys the new shape and walks its
 * run to the ledger; until then the old one would keep drafting with the
 * old model, whatever Settings says.
 */
export function forgetAllExecutions(): void {
  anchors.clear();
  unavailable.clear();
}

async function alignOnce(projectId: string, ledger: LedgerPosition): Promise<"aligned" | "no_execution" | "failed"> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return "no_execution";
  await launchProjectLifecycle({ projectId });
  // Two signals per stage below the ledger's, and one more to read the result.
  for (let sent = 0; sent <= 2 * ledger.stage; sent += 1) {
    const parked = await parkedPosition(anchor, FIRST_PARK_WAIT_MS);
    if (parked === "dead") {
      // The same path a refused signal takes: the caller forgets this
      // deployment and deploys again.
      throw new HubApiError(409, anchor, "the deployment's run has ended");
    }
    if (!parked || parked.signalName === null) {
      // The shape of every run under the deployment goes with the message:
      // which steps are parked or in flight, and what failed. Without it the
      // line says only that a wait ran out.
      const shape = (await debugRuns(projectId)) as Record<string, { kinds?: unknown } | unknown>;
      for (const value of Object.values(shape)) if (value && typeof value === "object") delete (value as { kinds?: unknown }).kinds;
      console.error(
        `[executor] ${projectId}: the run never parked, so it could not be brought to stage ${ledger.stage}. ${JSON.stringify(shape)}`,
      );
      return "failed";
    }
    const position = positionOfSignal(parked.stage, parked.signalName)!;
    const step = alignmentStep(position, ledger);
    if (step.kind === "aligned") {
      if (sent > 0) console.log(`[executor] ${projectId}: the run now stands with the ledger at stage ${ledger.stage} (${ledger.state}).`);
      return "aligned";
    }
    if (step.kind !== "deliver") {
      console.error(
        `[executor] ${projectId}: the run is parked at stage ${position.stage} (${position.at}) and the ledger at ${ledger.stage} (${ledger.state}): ` +
          (step.kind === "ahead" ? "the run is ahead of the ledger and is not rewound." : step.reason),
      );
      return "failed";
    }
    const gate = parked.signalName === exhaustedSignal(parked.stage) ? "exhausted" : "gate";
    const signal = stageSignal(position.stage, step.command, gate);
    try {
      await deploymentRuns.signal(anchor, {
        runId: anchor,
        signalName: signal.name,
        signalId: crypto.randomUUID(),
        payload: { ...signal.payload },
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) throw new HubApiError(409, signal.name, cause.message);
      // As in `deliverStageSignal`: only a reported `ApiError` reads as a
      // refused signal. Anything else propagates rather than being read as
      // "the run rejected this stage".
      if (!(cause instanceof ApiError)) throw cause;
      console.error(
        `[executor] ${projectId}: the hub did not accept ${signal.name} while bringing the run to stage ${ledger.stage} (${cause.status}) ${cause.message}.`,
      );
      return "failed";
    }
    // The signal is accepted before the sidecar consumes it, and the fold
    // shows the step parked until then. Read again only once it has moved:
    // a second signal to the same step would queue behind the first and be
    // consumed by a round nobody asked to leave.
    await consumed(anchor, parked);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
  console.error(`[executor] ${projectId}: the run did not reach stage ${ledger.stage} within the expected number of signals.`);
  return "failed";
}

/** Projects whose last signal the hub refused: the ledger and the run disagree. */
const divergent = new Set<string>();

export function divergentProjects(): readonly string[] {
  return [...divergent];
}

/** Whether the project's deployment has a fired run this process knows of. */
export function hasExecution(projectId: string): boolean {
  return anchors.has(projectId);
}

/**
 * The project behind an anchor run id, for callers that only have the run's
 * own address (a sidecar's `agent.event` frame carries `<anchorRunId>@domain`,
 * never the project id). `null` when the anchor is not one this process has
 * resolved a deployment for yet.
 */
export function projectForAnchor(anchorRunId: string): string | null {
  for (const [projectId, anchor] of anchors) {
    if (anchor === anchorRunId) return projectId;
  }
  return null;
}

/** Why a project has no run: no offering connected yet, or a host that cannot place sidecars. */
export function executionUnavailable(projectId: string): ExecutionUnavailableReason | null {
  return unavailable.get(projectId) ?? null;
}

/** Every signal name the project's run is currently parked on, for diagnosis. */
export async function parkedSignalNames(projectId: string): Promise<string[]> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return [];
  return parkedSteps(await foldRuns(anchor)).flatMap((step) => (step.signalName ? [step.signalName] : []));
}

/** Diagnostic view of every run under the project's deployment: step phases and any read error. */
export async function debugRuns(projectId: string): Promise<unknown> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return { anchor: null };
  const runIds = await deploymentRuns.list(anchor);
  const out: Record<string, unknown> = { anchor, runIds };
  for (const runId of runIds) {
    try {
      const events = await deploymentRuns.events(anchor, runId);
      let state = emptyState(runId);
      for (const event of events) {
        state = applyEvent(state, { ...event.body, seq: event.seq, kind: event.type } as unknown as WorkflowEvent);
      }
      out[runId] = {
        kinds: events.map((event) => `${event.seq}:${event.type}`),
        steps: [...state.steps.values()].map((step) => `${step.stepId}=${step.phase}${step.awaitingSignal ? `(${step.awaitingSignal.name})` : ""}`),
        children: [...state.children.entries()].map(([id, child]) => `${id}<-${child.spawnedBy}`),
        // A failed or cancelled step carries its reason in the event body; the
        // kinds list alone cannot say why a step ended.
        failures: events
          .filter((event) => /fail|error|cancel|timeout/i.test(event.type))
          .map((event) => ({ seq: event.seq, type: event.type, body: event.body })),
      };
    } catch (cause) {
      out[runId] = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return out;
}

export type StageIteration = { readonly runId: string; readonly events: HubRunEvent[] };

/**
 * Every iteration child run of a stage's revise loop, oldest first.
 *
 * A loop iteration's run id is deterministic (`loopBodyRunId`), so rather
 * than folding every run's `state.children` map (as `parkedSteps` does, to
 * learn which stage a parked run belongs to) this walks the index straight:
 * iteration 0, 1, 2, ... until one is not among the deployment's run ids.
 * That is the one place this stage-thread projection needs to know how a
 * loop names its children; everything past this function reads iterations as
 * plain `{runId, events}` pairs.
 */
export async function stageIterations(
  projectId: string,
  stage: Stage,
  options: {
    /**
     * Only the anchor the project runs under now. A round can only run
     * there, so a caller waiting on one must not read an earlier anchor's
     * parked iteration as the newest; the thread, which reads history,
     * wants every anchor.
     */
    readonly currentOnly?: boolean;
  } = {},
): Promise<StageIteration[]> {
  const current = anchors.get(projectId) ?? (await anchorFor(projectId));
  const history = options.currentOnly ? (current ? [current] : []) : await anchorsFor(projectId);
  const loopId = reviseStepId(stage);
  const iterations: StageIteration[] = [];
  // Oldest anchor first, so the newest iteration is last whichever anchor
  // it ran under.
  for (const anchor of history) {
    const runIds = new Set(await runIdsUnder(anchor, anchor === current));
    for (let index = 0; ; index += 1) {
      const runId = loopBodyRunId(anchor, loopId, index);
      if (!runIds.has(runId)) break;
      iterations.push({ runId, events: await deploymentRuns.events(anchor, runId) });
    }
  }
  return iterations;
}

/**
 * Resolves a step output ref to the value it names: `inline:<json>` is
 * parsed directly (the ref carries the value itself), `blob:<sha>` is
 * fetched through the deployment's blob route first. One place to change if
 * the ref format ever grows a third shape.
 */
export async function readOutputRef(anchor: string, runId: string, ref: string): Promise<unknown> {
  if (ref.startsWith("inline:")) return JSON.parse(ref.slice("inline:".length));
  const match = /^blob:(.+)$/.exec(ref);
  if (!match) throw new Error(`Unrecognized step output ref: ${ref}`);
  const bytes = await deploymentRuns.blob(anchor, runId, match[1]!);
  if (!bytes) throw new Error(`Blob ${match[1]} for run ${runId} was not found.`);
  return JSON.parse(new TextDecoder().decode(bytes));
}
