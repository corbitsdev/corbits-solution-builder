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
 * The run *record* below (`StoredRun`) is the one piece still in process
 * memory: the product fields the engine reads off a run (`routeTargetStage`,
 * `costApprovalVersionId`, `packetId`, `checkpointRef`, ...) have no home on
 * the hub run yet. Moving them onto the ledger thread is the remaining slice
 * of CL-7627.
 */
import { applyEvent, emptyState, type WorkflowEvent } from "@intx/workflow";
import type { Command, RunKind, RunState, Stage } from "@solutions-builder/app/ledger";
import { stageOfStepId, stageSignal } from "@solutions-builder/app/workflows/stage-loop";
import { deploymentRuns } from "./hub-client.js";
import { ensureLifecycleDeployment } from "./workflow-deploy.js";

/** What a signal delivery actually did, so a caller can tell nothing from broken. */
export type DeliveryOutcome = "delivered" | "no_execution" | "failed";

/**
 * The run record — everything `table.run` used to persist, now kept here
 * instead. Stage and state are the ledger's own vocabulary, resolved against
 * this store rather than a database row; the rest (`sourceRunId`, `originId`,
 * `routeTargetStage`, `costApprovalVersionId`, `packetId`, `checkpointRef`)
 * are product-specific fields the platform has no column for, carried
 * forward unchanged because `engine.ts` and `store/projects.ts` both still
 * read every one of them (grepped, not assumed — `stage.retry`/`build.resume`
 * read `checkpointRef` and `packetId` off the prior run; `build.answer` reads
 * `originId`; `stage.select_route` reads `routeTargetStage`; `build.freeze`
 * reads `costApprovalVersionId`; the UI's `Run` type reads `packetId` and
 * `terminalReason`).
 *
 * In-memory only, same as the rest of this module: a host restart loses
 * in-flight runs, which is accepted for this pass. There is deliberately no
 * second table standing in for `table.run` — that would just move the "two
 * runners" problem sideways instead of ending it.
 */
export type StoredRun = {
  readonly id: string;
  readonly projectId: string;
  readonly kind: RunKind;
  readonly stage: Stage;
  readonly state: RunState;
  readonly sourceRunId: string | null;
  readonly originId: string;
  readonly terminalReason: string | null;
  readonly costApprovalVersionId: string | null;
  readonly routeTargetStage: number | null;
  readonly packetId: string | null;
  readonly checkpointRef: string | null;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
};

const runsById = new Map<string, StoredRun>();
/** Append-only per project, in creation order — mirrors `ORDER BY created_at`. */
const runsByProject = new Map<string, string[]>();

/** Records a new run. The id is minted by the caller, same as `table.run` before. */
export function putRunRecord(record: StoredRun): void {
  runsById.set(record.id, record);
  const ids = runsByProject.get(record.projectId);
  if (ids) ids.push(record.id);
  else runsByProject.set(record.projectId, [record.id]);
}

export function getRunRecord(runId: string): StoredRun | undefined {
  return runsById.get(runId);
}

/** Merges a patch into an existing run record. Throws on an unknown id — a coding error, not a user one. */
export function updateRunRecord(
  runId: string,
  patch: Partial<Omit<StoredRun, "id" | "projectId">>,
): StoredRun {
  const existing = runsById.get(runId);
  if (!existing) throw new Error(`executor: no run record ${runId}`);
  const updated: StoredRun = { ...existing, ...patch };
  runsById.set(runId, updated);
  return updated;
}

/** The most recently created run for a project that has not ended. */
export function activeRunRecord(projectId: string): StoredRun | undefined {
  const ids = runsByProject.get(projectId) ?? [];
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const run = runsById.get(ids[i]!);
    if (run && run.endedAt === null) return run;
  }
  return undefined;
}

/** Every run for a project, oldest first — the full history a project detail view shows. */
export function runRecordsForProject(projectId: string): StoredRun[] {
  return (runsByProject.get(projectId) ?? []).map((id) => runsById.get(id)!);
}


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
export async function deliverStageSignal(
  projectId: string,
  command: Command,
  payload: Record<string, unknown> = {},
  signalId: string = crypto.randomUUID(),
): Promise<DeliveryOutcome> {
  const anchor = anchors.get(projectId) ?? (await anchorFor(projectId));
  if (!anchor) return "no_execution";
  const parked = parkedSteps(await foldRuns(anchor));
  // The command lands on whichever stage the run is parked at; the ledger has
  // already decided it is allowed there.
  const signal = parked
    .flatMap((step) => [stageSignal(step.stage, command, "gate"), stageSignal(step.stage, command, "exhausted")]
      .map((candidate) => ({ step, signal: candidate })))
    .find(({ step, signal }) => step.signalName === signal.name)?.signal;
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
      };
    } catch (cause) {
      out[runId] = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return out;
}
