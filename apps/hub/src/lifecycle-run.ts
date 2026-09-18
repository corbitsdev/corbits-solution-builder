/**
 * The project's lifecycle deployment, as a thin hub client.
 *
 * Each project has its own deployment of the generated lifecycle
 * (`lifecycle-deploy.ts`); the hub places it on Interchange's own sidecar and
 * the sidecar runs it. This module fires the deployment's top-level run,
 * delivers gate commands as signals, and reads where the run stands by folding
 * the run's own committed events. Nothing here executes a workflow, and nothing
 * here writes a host run record — run state moves in the workflow definition
 * in the app package.
 */
import { ApiError } from "@intx/hub-client";
import { loopBodyRunId } from "@intx/workflow";
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { reviseStepId, stageSignal, type StageSignal } from "@solutions-builder/app/workflows/stage-loop";
import {
  currentStep,
  foldRun,
  parkedSteps,
  projectState,
  type FoldedRun,
  type StageStatus,
} from "@solutions-builder/app/project-state";
import { assets, deploymentRuns, workflows, type HubRunEvent } from "./hub-client.js";
import {
  ensureLifecycleDeployment,
  lifecycleAssetName,
  type LifecycleDeployment,
} from "./lifecycle-deploy.js";
import { readProject } from "./project-records.js";

/** What a signal delivery actually did, so a caller can tell nothing from broken. */
export type DeliveryOutcome = "delivered" | "no_execution" | "failed";

/** Why a project has no execution: no model provider connected, or no host to place a sidecar on. */
export type ExecutionUnavailableReason = Extract<LifecycleDeployment["status"], "no_offering" | "no_host">;

// --- The deployment behind a project -------------------------------------------

/** Anchor run id (= deployment id) per project, remembered once resolved. */
const anchors = new Map<string, string>();
/**
 * The tenant's `policyVersion` the cached anchor was resolved at. A stakeholder
 * write goes through the installer over `/hub`, never through this process, so
 * the cached anchor cannot be told it is stale — it has to be asked. A policy
 * write moves `policyVersion` (and only a policy write does), which is what
 * tells a stale anchor apart from a current one on reuse.
 */
const anchorPolicyVersions = new Map<string, number>();
/** Why a project has no execution, for the status line. */
const unavailable = new Map<string, ExecutionUnavailableReason>();

/**
 * Resolves the anchor deployment for a project, reusing the remembered one.
 * Reuse is conditional on the tenant's `policyVersion` still matching the one
 * the anchor was resolved at: an installer stakeholder write lands as a
 * version bump this process never sees directly, so a mismatch forgets the
 * anchor and the resolve below redeploys/realigns from the new policy. A
 * tenant read that fails or finds nothing keeps the remembered anchor rather
 * than stranding a live execution.
 */
async function anchorFor(projectId: string, replace = false): Promise<string | null> {
  const known = anchors.get(projectId);
  if (known && !replace) {
    const seen = anchorPolicyVersions.get(projectId);
    const current = await readPolicyVersion(projectId);
    if (current === undefined || current === seen) return known;
    anchors.delete(projectId);
    anchorPolicyVersions.delete(projectId);
  }
  const deployment = await ensureLifecycleDeployment(projectId, { replace });
  if (deployment.status === "no_offering" || deployment.status === "no_host") {
    unavailable.set(projectId, deployment.status);
    return null;
  }
  unavailable.delete(projectId);
  anchors.set(projectId, deployment.deploymentId);
  const version = await readPolicyVersion(projectId);
  if (version !== undefined) anchorPolicyVersions.set(projectId, version);
  return deployment.deploymentId;
}

/** The tenant's `policyVersion`, or undefined when the tenant cannot be read. */
async function readPolicyVersion(projectId: string): Promise<number | undefined> {
  try {
    return (await readProject(projectId))?.policyVersion;
  } catch {
    return undefined;
  }
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
  const current = await anchorFor(projectId);
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

/** Every run under the deployment, folded from its committed events, with the events kept for the ledger hook below. */
async function foldRunsWithEvents(anchorRunId: string): Promise<{ runId: string; events: HubRunEvent[]; folded: FoldedRun }[]> {
  const runIds = await deploymentRuns.list(anchorRunId);
  const folded: { runId: string; events: HubRunEvent[]; folded: FoldedRun }[] = [];
  for (const runId of runIds) {
    const events = await deploymentRuns.events(anchorRunId, runId);
    folded.push({ runId, events, folded: foldRun(runId, events) });
  }
  return folded;
}

/** Every run under the deployment, folded from its committed events. */
async function foldRuns(anchorRunId: string): Promise<FoldedRun[]> {
  return (await foldRunsWithEvents(anchorRunId)).map((entry) => entry.folded);
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

export type { StageStatus };

/** Where the project's run stands, read from the hub's own event log. */
export async function projectExecutionStatus(projectId: string): Promise<StageStatus | null> {
  const anchor = await anchorFor(projectId);
  if (!anchor) return null;
  const withEvents = await foldRunsWithEvents(anchor);
  const status = projectState(withEvents.map((entry) => entry.folded));
  // Write-on-read: a client signal over `/hub` never calls `commandFrom`, so
  // the admitted gate commands already committed on the run are recorded as
  // ledger mail here, where the events are already in hand. Best-effort and
  // idempotent — a receipt skips what delivery or an earlier read recorded —
  // and never allowed to break the read itself.
  try {
    const awaitedByRun = new Map<string, Set<string>>();
    for (const park of parkedSteps(withEvents.map((entry) => entry.folded))) {
      if (park.signalName === null) continue;
      const known = awaitedByRun.get(park.runId) ?? new Set<string>();
      known.add(park.signalName);
      awaitedByRun.set(park.runId, known);
    }
    const { recordAdmittedGates } = await import("./command-ledger.js");
    await recordAdmittedGates(
      projectId,
      withEvents.map((entry) => ({
        runId: entry.runId,
        events: entry.events,
        awaited: awaitedByRun.get(entry.runId) ?? new Set<string>(),
      })),
    );
  } catch (cause) {
    console.error(`[executor] ${projectId}: could not record admitted gates from the run:`, cause);
  }
  return status;
}

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
 * already decided it is allowed there. Accept and fail match the evidence
 * park after the build agent (`stageSignal`), not gate-8, while the
 * iteration is live.
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

/**
 * Delivers a host-relayed command as the signal the parked stage waits on.
 * `no_execution` when nothing awaits that name, so a round the run cannot
 * consume is visible rather than swallowed. `signalId` is the command's own
 * idempotency key: a retried command is one signal on the runtime and one
 * turn on the ledger. The ledger turn itself is the caller's to write.
 */
export async function deliverStageSignal(
  projectId: string,
  command: Command,
  payload: Record<string, unknown> = {},
  signalId: string = crypto.randomUUID(),
  expectedStage?: Stage,
): Promise<DeliveryOutcome> {
  const anchor = await anchorFor(projectId);
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
 * Forgets the deployment this process resolved for a project, so the next
 * command resolves it again: a fresh deployment when the rendered lifecycle
 * changed (a stakeholder added), or when the old one is dead.
 */
export function forgetExecution(projectId: string): void {
  anchors.delete(projectId);
  anchorPolicyVersions.delete(projectId);
}

/**
 * Forgets every project's deployment. The lifecycle is rendered with the
 * model it will draft with, pinned at deploy time, so a change to what the
 * catalog serves is a different lifecycle. The next command on any project
 * resolves its deployment again, which deploys the new shape.
 */
export function forgetAllExecutions(): void {
  anchors.clear();
  anchorPolicyVersions.clear();
  unavailable.clear();
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

/** The deployment id the project's lifecycle is running under, once resolved. */
export async function currentAnchor(projectId: string): Promise<string | null> {
  return anchorFor(projectId);
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
  const anchor = await anchorFor(projectId);
  if (!anchor) return [];
  return parkedSteps(await foldRuns(anchor)).flatMap((step) => (step.signalName ? [step.signalName] : []));
}

/** Diagnostic view of every run under the project's deployment: step phases and any read error. */
export async function debugRuns(projectId: string): Promise<unknown> {
  const anchor = await anchorFor(projectId);
  if (!anchor) return { anchor: null };
  const runIds = await deploymentRuns.list(anchor);
  const out: Record<string, unknown> = { anchor, runIds };
  for (const runId of runIds) {
    try {
      const events = await deploymentRuns.events(anchor, runId);
      const { state } = foldRun(runId, events);
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
  const current = await anchorFor(projectId);
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
