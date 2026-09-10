/**
 * The in-process workflow executor.
 *
 * The in-process execution path: each
 * project's `project-lifecycle` run executes through the platform's own
 * runtime (`runtimeRun` from `@intx/workflow`), wired to its in-memory
 * adapters exactly the way `runLocal` wires them for tests. Nothing here is a
 * stand-in — it is the platform's own runtime, driving our generated
 * definitions, in-process.
 *
 * `createWorkflowSupervisor` (a real subprocess, signed IPC, a mail bus) is
 * out of reach and out of scope; `runtimeRun` is the runtime body underneath
 * it, and that is what this module drives directly.
 *
 * This module is now the sole authority for a project's run: which stage,
 * what state, and whether its runtime execution is parked at a signal gate.
 * `table.run` is gone — `engine.ts` and `store/projects.ts` read and write
 * the run record kept here instead. State here is process-memory only: a
 * host restart loses in-flight runs, which is accepted for this pass;
 * `launchProjectLifecycle` is idempotent, so a caller that finds no
 * execution relaunches one on demand.
 */
/** What a signal delivery actually did, so a caller can tell nothing from broken. */
export type DeliveryOutcome = "delivered" | "no_execution" | "failed";

import { createDefaultDirectorRegistry } from "@intx/agent";
import {
  applyEvent,
  createInMemoryBlobSubstrate,
  createInMemoryRepoStore,
  createInMemoryScheduler,
  createInMemorySignalChannel,
  createNoopDrainController,
  createSpawnLoopIteration,
  emptyState,
  enumerateInlineLoopBodies,
  rewriteInlineChildWorkflowBodies,
  runtimeRun,
  type RepoStore,
  type SignalChannel,
  type SpawnChildWorkflow,
  type WorkflowDefinition,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";
import type { Command, RunKind, RunState, Stage } from "@solutions-builder/app/ledger";
import { projectLifecycleDefinition } from "@solutions-builder/app/workflows/project-lifecycle";
import { stageSignal } from "@solutions-builder/app/workflows/stage-loop";

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
  readonly branchId: string;
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

/**
 * One stage's own child run inside a project's lifecycle: its repo store and
 * its own signal channel. `runLocal`'s `childWorkflow` resolution is a
 * private closure that discards both once the child completes — this is the
 * one thing this module reimplements the top-level wiring to keep hold of.
 */
type StageHandle = {
  readonly stage: Stage;
  readonly runId: string;
  readonly repoStore: RepoStore;
  readonly signalChannel: SignalChannel;
};

type Execution = {
  readonly projectId: string;
  readonly topRunId: string;
  /** Keyed by stage-step id ("stage-1", ...), accumulated as stages spawn. */
  readonly stages: Map<string, StageHandle>;
  /** The most recently spawned stage — the one a signal should reach. */
  currentStepId: string | null;
  settled: { outcome: "completed" | "failed" | "cancelled" | "error"; detail: string } | null;
};

const executions = new Map<string, Execution>();

// One director registry for the process: stateless configuration, not
// per-run state, so every project's runtime shares it — same as the spike.
const directors = createDefaultDirectorRegistry();

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * The terminal `SpawnChildWorkflow` for a project's top-level lifecycle run.
 * Mirrors `runLocal`'s private `createInMemorySpawnChild` — same recursive
 * `runtimeRun` call, same in-memory adapters — but stashes each stage's own
 * repo store and signal channel on `execution` instead of discarding them
 * once the child completes.
 */
function makeSpawnChild(execution: Execution, childBodies: ReadonlyMap<string, WorkflowDefinition>): SpawnChildWorkflow {
  return async ({ definitionRef, childRunId, input, parentStepId, signal, depth, maxChildSpawnDepth }) => {
    const resolved = childBodies.get(definitionRef);
    if (resolved === undefined) {
      throw new Error(`executor: no lifted definition for childWorkflow ref ${definitionRef}`);
    }

    // A stage definition embeds a `loop` but no further inline `childWorkflow`
    // — checked, not assumed, exactly like the spike.
    const { workflow: rewrittenChild, bodies: grandchildBodies } = rewriteInlineChildWorkflowBodies(resolved);
    if (grandchildBodies.length > 0) {
      throw new Error(
        `executor: stage definition ${definitionRef} embeds a nested childWorkflow; this executor only wires one level deep`,
      );
    }

    const childRepoStore = createInMemoryRepoStore();
    const childSignalChannel = createInMemorySignalChannel({ newId });
    const stageNumber = Number(parentStepId.replace("stage-", "")) as Stage;
    execution.stages.set(parentStepId, {
      stage: stageNumber,
      runId: childRunId,
      repoStore: childRepoStore,
      signalChannel: childSignalChannel,
    });
    execution.currentStepId = parentStepId;

    const childEnv: WorkflowRuntimeEnv = {
      repoStore: childRepoStore,
      scheduler: createInMemoryScheduler({ repoStore: childRepoStore, clock: () => new Date() }),
      signalChannel: childSignalChannel,
      blobs: createInMemoryBlobSubstrate(),
      directors,
      authorize: async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null }),
      invokeStep: async () => ({ output: null }),
      spawnChild: async ({ definitionRef: ref }) => {
        throw new Error(`executor: unexpected childWorkflow spawn (${ref}) inside a stage`);
      },
      clock: () => new Date(),
      newId,
      drain: createNoopDrainController(rewrittenChild),
    };

    const loopBodies = new Map<string, WorkflowDefinition>();
    for (const loopBody of enumerateInlineLoopBodies(rewrittenChild)) {
      loopBodies.set(loopBody.ref, loopBody.definition);
    }
    childEnv.spawnLoopIteration = createSpawnLoopIteration(childEnv, loopBodies);

    const childRun = runtimeRun(rewrittenChild, childEnv, {
      runId: childRunId,
      triggerPayload: input,
      depth,
      maxChildSpawnDepth,
    });

    const onParentAbort = () => void childRun.cancel("supervisor-operator", "parent cancelled");
    signal.addEventListener("abort", onParentAbort);
    try {
      const result = await childRun.complete;
      return { terminalStatus: result.terminalStatus };
    } finally {
      signal.removeEventListener("abort", onParentAbort);
    }
  };
}

/**
 * Launches a project's `project-lifecycle` run in-process. Idempotent per
 * project — there is exactly one lifecycle run per project, so a second call
 * for a project that already has a live execution is a no-op.
 */
export async function launchProjectLifecycle(args: {
  readonly projectId: string;
  readonly branchId: string;
}): Promise<void> {
  if (executions.has(args.projectId)) return;

  const lifecycle = projectLifecycleDefinition();
  const { workflow: rewrittenLifecycle, bodies: lifecycleBodies } = rewriteInlineChildWorkflowBodies(lifecycle);
  const childBodies = new Map(lifecycleBodies.map((body) => [body.ref, body.definition]));

  const topRunId = `lifecycle-${args.projectId}`;
  const execution: Execution = {
    projectId: args.projectId,
    topRunId,
    stages: new Map(),
    currentStepId: null,
    settled: null,
  };
  executions.set(args.projectId, execution);

  const topRepoStore = createInMemoryRepoStore();
  const topEnv: WorkflowRuntimeEnv = {
    repoStore: topRepoStore,
    scheduler: createInMemoryScheduler({ repoStore: topRepoStore, clock: () => new Date() }),
    signalChannel: createInMemorySignalChannel({ newId }),
    blobs: createInMemoryBlobSubstrate(),
    directors,
    authorize: async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null }),
    invokeStep: async () => ({ output: null }),
    spawnChild: makeSpawnChild(execution, childBodies),
    clock: () => new Date(),
    newId,
    drain: createNoopDrainController(rewrittenLifecycle),
  };

  const topRun = runtimeRun(rewrittenLifecycle, topEnv, {
    runId: topRunId,
    triggerPayload: { projectId: args.projectId, branchId: args.branchId },
  });

  // The lifecycle run must not settle on its own — stage 1 parks, so its
  // `complete` stays pending for the run's whole life. If it ever does
  // settle, that is worth recording rather than leaving an unhandled
  // rejection.
  topRun.complete
    .then((result) => {
      execution.settled = { outcome: result.terminalStatus, detail: result.terminalStatus };
    })
    .catch((cause: unknown) => {
      execution.settled = {
        outcome: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    });

  // Best-effort: give the run a moment to reach its first park so a status
  // read immediately after launch already sees stage 1, without blocking
  // forever if something stops it from ever spawning one.
  const deadline = Date.now() + 2000;
  while (execution.currentStepId === null && execution.settled === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export type StageStatus = {
  readonly stage: Stage;
  readonly stepId: string;
  readonly parked: boolean;
  readonly signalName: string | null;
};

async function readParkedSignal(handle: StageHandle): Promise<{ parked: boolean; signalName: string | null }> {
  const events = await handle.repoStore.read(handle.runId);
  let state = emptyState(handle.runId);
  for (const event of events) state = applyEvent(state, event);
  for (const step of state.steps.values()) {
    if (step.phase === "awaiting-signal") {
      return { parked: true, signalName: step.awaitingSignal?.name ?? null };
    }
  }
  return { parked: false, signalName: null };
}

/**
 * Which stage a project's runtime execution is on, and whether it is parked
 * at a signal gate. `null` when the project has no live execution — never
 * launched, or launched in a process that has since restarted.
 */
export async function projectExecutionStatus(projectId: string): Promise<StageStatus | null> {
  const execution = executions.get(projectId);
  if (!execution || execution.currentStepId === null) return null;
  const handle = execution.stages.get(execution.currentStepId);
  if (!handle) return null;
  const { parked, signalName } = await readParkedSignal(handle);
  return { stage: handle.stage, stepId: execution.currentStepId, parked, signalName };
}

/**
 * Delivers the signal a committed gate command corresponds to
 * (`stageSignal` from `stage-loop.ts`) into the project's currently active
 * stage run. Returns `false` — not an error — when the project has no live
 * execution: the ledger transition already moved the project; this is a
 * best-effort shadow of it, not the thing that makes the command valid.
 */
export async function deliverStageSignal(
  projectId: string,
  command: Command,
  payload: Record<string, unknown> = {},
): Promise<DeliveryOutcome> {
  const execution = executions.get(projectId);
  if (!execution || execution.currentStepId === null) return "no_execution";
  const handle = execution.stages.get(execution.currentStepId);
  if (!handle) return "no_execution";
  try {
    await handle.signalChannel.deliver(stageSignal(command), payload);
    return "delivered";
  } catch (cause) {
    // Two state machines that disagree and never say so is the failure this
    // reports rather than swallows. The ledger has already moved; the runtime
    // has not, and from here it never will on its own.
    console.error(
      `[executor] ${projectId}: the runtime did not accept ${stageSignal(command)}; ` +
        `the ledger has moved and the runtime has not. ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    divergent.add(projectId);
    return "failed";
  }
}

/**
 * Projects whose runtime run is known to disagree with the ledger.
 *
 * A shadow nobody can see is worse than no shadow. This is what a caller — a
 * status route, a gate — reads to find out that the two have parted company,
 * rather than the divergence sitting silently in a map.
 */
const divergent = new Set<string>();

export function divergentProjects(): readonly string[] {
  return [...divergent];
}

/**
 * Whether a project has a live runtime run at all.
 *
 * False after a restart for every project that was mid-flight, which is the
 * honest answer: the runs live in this process's memory and the process is
 * new. `launchProjectLifecycle` is idempotent, so a caller that finds no
 * execution can start one.
 */
export function hasExecution(projectId: string): boolean {
  return executions.has(projectId);
}
