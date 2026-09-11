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
import { applyEvent, emptyState, loopBodyRunId, type WorkflowEvent } from "@intx/workflow";
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { reviseStepId, stageOfStepId, stageSignal, type StageSignal } from "@solutions-builder/app/workflows/stage-loop";
import { deploymentRuns, type HubRunEvent } from "./hub-client.js";
import { ensureLifecycleDeployment } from "./workflow-deploy.js";

/** What a signal delivery actually did, so a caller can tell nothing from broken. */
export type DeliveryOutcome = "delivered" | "no_execution" | "failed";

// --- The deployment behind a project -------------------------------------------

/** Anchor run id (= deployment id) per project, remembered once resolved. */
const anchors = new Map<string, string>();
/** Why a project has no execution, for the status line. */
const unavailable = new Map<string, string>();

async function anchorFor(projectId: string): Promise<string | null> {
  const known = anchors.get(projectId);
  if (known) return known;
  const deployment = await ensureLifecycleDeployment(projectId);
  if (deployment.status === "no_offering" || deployment.status === "no_host") {
    unavailable.set(projectId, deployment.status);
    return null;
  }
  unavailable.delete(projectId);
  anchors.set(projectId, deployment.deploymentId);
  return deployment.deploymentId;
}

type FoldedRun = { readonly runId: string; readonly state: ReturnType<typeof emptyState> };

/** Every run under the deployment, folded from its committed events. */
async function foldRuns(anchorRunId: string): Promise<FoldedRun[]> {
  const runIds = await deploymentRuns.list(anchorRunId);
  const folded: FoldedRun[] = [];
  for (const runId of runIds) {
    const events = await deploymentRuns.events(anchorRunId, runId);
    let state = emptyState(runId);
    for (const event of events) {
      // The hub stores the discriminator as `type`; the runtime reads it as
      // `kind`. The stored body already carries `seq` and `type`.
      state = applyEvent(state, { ...event.body, seq: event.seq, kind: event.type } as unknown as WorkflowEvent);
    }
    folded.push({ runId, state });
  }
  return folded;
}

type Parked = { readonly runId: string; readonly stepId: string; readonly stage: Stage; readonly signalName: string | null };

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
      parked.push({ runId: run.runId, stepId, stage, signalName: step.awaitingSignal?.name ?? null });
    }
  }
  return parked;
}

/** The top-level stage step currently running, when nothing is parked. */
function currentStep(runs: FoldedRun[]): { stepId: string; stage: Stage } | null {
  for (const run of runs) {
    for (const step of run.state.steps.values()) {
      const stage = stageOfStepId(step.stepId);
      if (step.phase === "in-flight" && stage !== null) return { stepId: step.stepId, stage };
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
};

/** Where the project's run stands, read from the hub's own event log. */
export async function projectExecutionStatus(projectId: string): Promise<StageStatus | null> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return null;
  const runs = await foldRuns(anchor);
  const [parked] = parkedSteps(runs);
  if (parked) return { stage: parked.stage, stepId: parked.stepId, parked: true, signalName: parked.signalName };
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
async function awaitingSignalFor(anchor: string, command: Command): Promise<StageSignal | null> {
  const deadline = Date.now() + PARK_WAIT_MS;
  for (;;) {
    const runs = await foldRuns(anchor);
    const signal = parkedSteps(runs)
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
): Promise<DeliveryOutcome> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return "no_execution";
  const signal = await awaitingSignalFor(anchor, command);
  if (!signal) return "no_execution";
  // Signals address the deployment's top-level run; a loop relays a named
  // signal into the iteration that awaits it.
  const response = await deploymentRuns.signal(anchor, {
    runId: anchor,
    signalName: signal.name,
    signalId,
    payload: { ...payload, ...signal.payload },
  });
  if (response.ok) {
    divergent.delete(projectId);
    return "delivered";
  }
  console.error(
    `[executor] ${projectId}: the hub did not accept ${signal.name} (${response.status}); ` +
      `the ledger has moved and the run has not. ${(await response.text()).slice(0, 300)}`,
  );
  divergent.add(projectId);
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
export function executionUnavailable(projectId: string): string | null {
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
export async function stageIterations(projectId: string, stage: Stage): Promise<StageIteration[]> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return [];
  const runIds = new Set(await deploymentRuns.list(anchor));
  const loopId = reviseStepId(stage);
  const iterations: StageIteration[] = [];
  for (let index = 0; ; index += 1) {
    const runId = loopBodyRunId(anchor, loopId, index);
    if (!runIds.has(runId)) break;
    iterations.push({ runId, events: await deploymentRuns.events(anchor, runId) });
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
