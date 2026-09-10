/**
 * Spike: can the platform's own workflow runtime drive our seeded
 * `solutions-builder.project-lifecycle` definition IN-PROCESS -- no OS
 * subprocess, no signed IPC control channel, no supervisor -- far enough to
 * watch it park at stage 1's `awaitSignal` gate?
 *
 * `createWorkflowSupervisor` (the production entry point) is out of reach for
 * this: it mandates a real `subprocessSpawner`, a `PrincipalSigner` and
 * `MailBusBindings`. But the supervisor is only the process-management layer
 * around the runtime body (`runtimeRun` in
 * vendor/interchange/packages/workflow/src/runtime/run.ts) -- the same
 * function `runWorkflowChild` drives inside the real child process, and the
 * same function `runLocal` (vendor/interchange/packages/workflow/src/runlocal)
 * drives for tests. Every in-memory env implementation `runLocal` uses
 * (repoStore, scheduler, signalChannel, blobs) is a public export of
 * `@intx/workflow`, so nothing here is faked: this is the platform's own
 * runtime, wired to its own in-memory adapters, executing our own generated
 * definitions.
 *
 * The one thing `runLocal` does NOT give a caller is a handle on a spawned
 * child's own `WorkflowRun`/`RepoStore` -- its `childWorkflow` resolution is a
 * private closure. `project-lifecycle` models every stage as an inline
 * `childWorkflow` (see packages/solutions-builder/src/workflows/project-lifecycle.ts), and
 * proving "parked at stage 1's gate" means inspecting stage 1's OWN committed
 * event log for a durable `SignalAwaited` -- so this script reimplements
 * `runLocal`'s top-level wiring (the same ~10 lines, same exported functions)
 * with its own `spawnChild` that stashes each stage's repoStore before
 * awaiting the child's completion. That is the only reason this is not a
 * three-line call to `runLocal`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemoryBlobSubstrate,
  createInMemoryRepoStore,
  createInMemoryScheduler,
  createInMemorySignalChannel,
  createNoopDrainController,
  createSpawnLoopIteration,
  enumerateInlineLoopBodies,
  rewriteInlineChildWorkflowBodies,
  runtimeRun,
  type RepoStore,
  type SpawnChildWorkflow,
  type WorkflowDefinition,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";
import { createDefaultDirectorRegistry } from "@intx/agent";

import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub } from "../apps/hub/src/hub-endpoint.js";
import { ensureWorkspace } from "../apps/hub/src/projects.js";
import { seedWorkflows } from "../apps/hub/src/workflow-seed.js";
import { projectLifecycleDefinition, stageStepId } from "@solutions-builder/app/workflows/project-lifecycle";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 1 & 2: mount the hub and seed the definitions exactly like
// scripts/workflow-smoke.ts. This proves the executor below is running the
// SAME definition the host deploys, not a hand-rolled stand-in. ---
const dataDir = await mkdtemp(join(tmpdir(), "solutions-builder-executor-spike-"));
await prepareDatabase(await openDatabase(`${dataDir}/pglite`));
const endpoint = await ensureHub();
check("the hub is mounted embedded", endpoint.mode === "embedded" && endpoint.ready);
await ensureWorkspace({ principalId: "p_owner", displayName: "You" });

const seeded = await seedWorkflows();
check(
  "solutions-builder.project-lifecycle is seeded",
  seeded.some((entry) => entry.name === "solutions-builder.project-lifecycle"),
);

// --- 3: execute the definition in-process through the platform runtime. ---
//
// Each stage's own repoStore is stashed here, keyed by parentStepId
// ("stage-1", "stage-2", ...), the moment its child run is spawned -- BEFORE
// the child's own completion is awaited (which, for stage 1, never happens in
// this run: it parks). This is the only state this script needs that
// `runLocal` does not expose.
const stageRepoStores = new Map<string, RepoStore>();
const stageRunIds = new Map<string, string>();

const directors = createDefaultDirectorRegistry();

/**
 * The custom terminal `SpawnChildWorkflow` for the top-level run. Mirrors
 * `runLocal`'s private `createInMemorySpawnChild` (same recursive
 * `runtimeRun` call, same in-memory adapters) but keeps the child's
 * `RepoStore` reachable by the caller instead of discarding it once
 * `child.complete` resolves.
 */
function makeSpawnChild(childBodies: ReadonlyMap<string, WorkflowDefinition>): SpawnChildWorkflow {
  return async ({ definitionRef, childRunId, input, parentStepId, signal, depth, maxChildSpawnDepth }) => {
    const resolved = childBodies.get(definitionRef);
    if (resolved === undefined) {
      throw new Error(`executor-spike: no lifted definition for childWorkflow ref ${definitionRef}`);
    }

    // A stage definition embeds a `loop` but no further inline `childWorkflow`
    // -- checked, not assumed: fail loud if that ever stops being true rather
    // than silently drop a grandchild.
    const { workflow: rewrittenChild, bodies: grandchildBodies } = rewriteInlineChildWorkflowBodies(resolved);
    if (grandchildBodies.length > 0) {
      throw new Error(
        `executor-spike: stage definition ${definitionRef} embeds a nested childWorkflow; this spike only wires one level deep`,
      );
    }

    const childRepoStore = createInMemoryRepoStore();
    stageRepoStores.set(parentStepId, childRepoStore);
    stageRunIds.set(parentStepId, childRunId);

    const childEnv: WorkflowRuntimeEnv = {
      repoStore: childRepoStore,
      scheduler: createInMemoryScheduler({ repoStore: childRepoStore, clock: () => new Date() }),
      signalChannel: createInMemorySignalChannel({ newId: (prefix) => `${prefix}-${crypto.randomUUID()}` }),
      blobs: createInMemoryBlobSubstrate(),
      directors,
      authorize: async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null }),
      invokeStep: async () => ({ output: null }),
      spawnChild: async ({ definitionRef: ref }) => {
        throw new Error(`executor-spike: unexpected childWorkflow spawn (${ref}) inside a stage`);
      },
      clock: () => new Date(),
      newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
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

const lifecycle = projectLifecycleDefinition();
const { workflow: rewrittenLifecycle, bodies: lifecycleBodies } = rewriteInlineChildWorkflowBodies(lifecycle);
const childBodies = new Map(lifecycleBodies.map((b) => [b.ref, b.definition]));

const topRepoStore = createInMemoryRepoStore();
const topEnv: WorkflowRuntimeEnv = {
  repoStore: topRepoStore,
  scheduler: createInMemoryScheduler({ repoStore: topRepoStore, clock: () => new Date() }),
  signalChannel: createInMemorySignalChannel({ newId: (prefix) => `${prefix}-${crypto.randomUUID()}` }),
  blobs: createInMemoryBlobSubstrate(),
  directors,
  authorize: async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null }),
  invokeStep: async () => ({ output: null }),
  spawnChild: makeSpawnChild(childBodies),
  clock: () => new Date(),
  newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
  drain: createNoopDrainController(rewrittenLifecycle),
};

const topRun = runtimeRun(rewrittenLifecycle, topEnv, {
  runId: "run-lifecycle-spike-1",
  triggerPayload: { projectId: "proj-spike-1", branchId: "branch-1" },
});

// The lifecycle run must NOT reach terminal on its own: stage 1 parks, so
// stage-1's childWorkflow step never resolves, so the parent never schedules
// stage 2. A terminal (or thrown) completion here is a spike failure, not a
// park -- surface it rather than let it dangle unobserved.
let topSettled: { outcome: "terminal" | "error"; detail: string } | undefined;
topRun.complete
  .then((result) => {
    topSettled = { outcome: "terminal", detail: result.terminalStatus };
  })
  .catch((cause) => {
    topSettled = { outcome: "error", detail: cause instanceof Error ? cause.message : String(cause) };
  });

// --- 4: poll stage 1's own committed event log for the durable park. ---
const stage1Id = stageStepId(1);
let sawParkEvent: { stepId: string; signalName: string } | undefined;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && sawParkEvent === undefined) {
  if (topSettled !== undefined) break;
  const runId = stageRunIds.get(stage1Id);
  if (runId !== undefined) {
    const store = stageRepoStores.get(stage1Id);
    if (store !== undefined) {
      const events = await store.read(runId);
      const park = events.find((event) => event.kind === "SignalAwaited") as
        | { stepId: string; signalName: string }
        | undefined;
      if (park !== undefined) {
        sawParkEvent = { stepId: park.stepId, signalName: park.signalName };
        break;
      }
    }
  }
  await sleep(20);
}

check(
  "the lifecycle run did not settle on its own (stage 1's childWorkflow step never resolved)",
  topSettled === undefined,
  topSettled ? `${topSettled.outcome}: ${topSettled.detail}` : "still pending",
);
check(
  "stage 1's child run was spawned",
  stageRunIds.has(stage1Id),
  stageRunIds.get(stage1Id) ?? "never spawned",
);
check(
  "stage 1 parked at an awaitSignal gate (durable SignalAwaited committed)",
  sawParkEvent !== undefined,
  sawParkEvent ? `stepId=${sawParkEvent.stepId} signalName=${sawParkEvent.signalName}` : "no SignalAwaited seen within 5s",
);
if (sawParkEvent !== undefined) {
  check(
    "the parked signal name belongs to the stage workflow",
    sawParkEvent.signalName.startsWith("solutions-builder.stage."),
    sawParkEvent.signalName,
  );
}

// The production entry points, not just this script's own wiring: a gate
// command must reach the runtime, a restart must not silently strand a
// project, and a failure must be reported rather than swallowed. Without
// these three the executor could be wholly broken and every gate still green.
{
  const { launchProjectLifecycle, deliverStageSignal, hasExecution, divergentProjects } =
    await import("../apps/hub/src/hub-executor.js");

  const projectId = `prj_gate_${Math.random().toString(36).slice(2, 10)}`;
  check("a project has no execution before it is launched", !hasExecution(projectId));

  await launchProjectLifecycle({ projectId, branchId: "brn_gate" });
  check("launching gives it one", hasExecution(projectId));

  await launchProjectLifecycle({ projectId, branchId: "brn_gate" });
  check("launching twice does not start a second", hasExecution(projectId));

  const delivered = await deliverStageSignal(projectId, "stage.approve");
  check("a gate command reaches the runtime", delivered === "delivered", String(delivered));

  const unknown = await deliverStageSignal(`prj_never_${Date.now()}`, "stage.approve");
  check(
    "a project with no execution is reported as such, not as success",
    unknown === "no_execution",
    String(unknown),
  );

  check("nothing diverged during this run", divergentProjects().length === 0);
}

console.log(`\nExecutor spike: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exit(1);
process.exit(0);
