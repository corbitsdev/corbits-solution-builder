/**
 * One build attempt, from the command that starts it to the ledger row that
 * ends it.
 *
 * The bounded bridge (`corbits-exec.ts`) reports an outcome and nothing else.
 * What the outcome *means* for the run is decided here, through the same
 * guard every other command goes through: a worker that is unavailable or
 * exits non-zero fails the run, with the reason, as the host's own `system`
 * principal. A worker that exits zero leaves the run running, because whether
 * its output is evidence is a person's call (`build.accept_evidence`), never
 * the exit status's.
 *
 * Until this existed the route recorded the bridge's final event and returned,
 * so a run whose worker could not even start sat under a "running" label with
 * a terminal result beside it, and nothing a person could do about either.
 */
import { execute, HOST_PRINCIPAL, type Actor, type CommandOutcome } from "./engine.js";
import { HostError } from "./errors.js";
import { newId } from "./ids.js";
import { projectDetail, readArtifactNode } from "./projects.js";
import { recordBuildEvent } from "./engine-ledger.js";
import { readRun } from "./runs.js";
import { localActor } from "./hub-client.js";
import { BRIDGE_CAPABILITIES, runBuildAttempt, type BridgeOutcome } from "./corbits-exec.js";

/** The host relays what the worker did; no person appears to have done it. */
const HOST_ACTOR: Actor = { principalId: HOST_PRINCIPAL, displayName: "Solutions Builder host" };

/** What a watcher of a running attempt is told: text as written, then that it ended. */
export type BuildOutputEvent = { type: "text"; text: string } | { type: "done" };

type InFlight = {
  readonly controller: AbortController;
  readonly startedAt: string;
  /** Everything the worker has written so far, both pipes, in arrival order; the tail once it is long. */
  transcript: string;
  readonly listeners: Set<(event: BuildOutputEvent) => void>;
};

/** Enough to read the last stretch of a long build; a full log is not what this is. */
const TRANSCRIPT_KEEP = 200_000;

/**
 * The attempts whose worker process is running right now, by run id, so a
 * cancel or interrupt decided through the ledger can reach the process, and
 * a window can watch what the process writes. The ledger row is applied
 * first; this only carries the decision to the worker. It is memory: a host
 * that restarts knows nothing of an attempt it was running, and says so.
 */
const inFlight = new Map<string, InFlight>();

/** Stops the worker for a run, if one is running. True when there was one. */
export function abortBuildAttempt(runId: string): boolean {
  const attempt = inFlight.get(runId);
  if (!attempt) return false;
  attempt.controller.abort();
  return true;
}

/** The running attempt for a run on this host, or null when this host is not running one. */
export function liveBuild(runId: string): { startedAt: string; transcript: string } | null {
  const attempt = inFlight.get(runId);
  return attempt ? { startedAt: attempt.startedAt, transcript: attempt.transcript } : null;
}

/** Watches a running attempt's output. Returns how to stop watching; a no-op when nothing is running. */
export function subscribeBuildOutput(runId: string, listener: (event: BuildOutputEvent) => void): () => void {
  const attempt = inFlight.get(runId);
  if (!attempt) return () => undefined;
  attempt.listeners.add(listener);
  return () => {
    attempt.listeners.delete(listener);
  };
}

export type StartedAttempt = {
  /** The command's outcome: `running` for a fresh start, `queued` for a retry. */
  readonly run: CommandOutcome;
  /**
   * Resolves once the worker has ended and the ledger reflects it, or with
   * `null` at once when no worker was started. A caller that must answer
   * before the worker ends does not await this.
   */
  readonly attempt: Promise<BridgeOutcome | null>;
};

/**
 * Applies `build.start_attempt` and, when that leaves the run `running`,
 * drives one worker attempt for it.
 *
 * From a terminal run the ledger queues a new attempt instead of running one,
 * so the worker is not started: the person starts the queued run, which is
 * the same decision they took the first time.
 */
export async function startBuildAttempt(args: {
  actor: Actor;
  projectId: string;
  runId: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}): Promise<StartedAttempt> {
  const run = await execute({
    type: "build.start_attempt",
    actor: args.actor,
    projectId: args.projectId,
    idempotencyKey: args.idempotencyKey ?? newId.command(),
    correlationId: newId.correlation(),
    ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
    payload: { runId: args.runId },
  });
  if (run.state !== "running") return { run, attempt: Promise.resolve(null) };
  return { run, attempt: driveAttempt(args.projectId, run.runId) };
}

async function driveAttempt(projectId: string, runId: string): Promise<BridgeOutcome> {
  // Registered before the first await: the run is `running` on the ledger
  // from the moment the caller has its outcome, so a cancel can arrive before
  // the prompt is even assembled and must still reach the worker.
  const attempt: InFlight = {
    controller: new AbortController(),
    startedAt: new Date().toISOString(),
    transcript: "",
    listeners: new Set(),
  };
  inFlight.set(runId, attempt);
  try {
    const prompt = await buildPrompt(projectId, runId);
    const outcome = await runBuildAttempt({
      runId,
      prompt,
      signal: attempt.controller.signal,
      onOutput: (chunk) => {
        attempt.transcript = (attempt.transcript + chunk).slice(-TRANSCRIPT_KEEP);
        for (const listener of attempt.listeners) listener({ type: "text", text: chunk });
      },
    });

    // The bridge's result is recorded as a run event on the ledger thread,
    // not as approval or evidence. Recorded, and the run settled, before a
    // watcher is told the attempt ended: "done" means the ledger has it.
    await recordBuildEvent(projectId, {
      id: newId.event(),
      runId,
      idempotencyKey: `${runId}:bridge-final`,
      cursor: 1,
      type: "bridge.final",
      severity: outcome.exitStatus === 0 ? "info" : "error",
      payload: {
        bridgeId: outcome.bridgeId,
        worker: outcome.worker,
        available: outcome.available,
        exitStatus: outcome.exitStatus,
        workspace: outcome.workspace,
        finalText: outcome.finalText.slice(0, 20_000),
        stderrTail: outcome.stderrTail,
        capabilities: BRIDGE_CAPABILITIES,
      },
      occurredAt: new Date(outcome.endedAt).toISOString(),
    });
    await settle(projectId, runId, outcome);
    return outcome;
  } finally {
    inFlight.delete(runId);
    for (const listener of attempt.listeners) listener({ type: "done" });
    attempt.listeners.clear();
  }
}

/**
 * The prompt the worker is handed: the plan says what to do, the requirements
 * it cites say when it is done.
 */
async function buildPrompt(projectId: string, runId: string): Promise<string> {
  const detail = await projectDetail(projectId, localActor().principalId);
  const packetRun = detail.runs.find((run) => run.id === runId);
  // The frozen packet is an artifact version; its hash is the version's.
  const packet = packetRun?.packetId ? await readArtifactNode(packetRun.packetId) : null;
  const targets = packet ? ((JSON.parse(packet.content) as { targets?: unknown }).targets ?? []) : [];

  const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
  const plan = live.find((node) => node.kind === "build_plan") ?? detail.nodes.find((node) => node.kind === "build_plan");
  const planText = plan ? (await readArtifactNode(plan.id)).content : "";
  const requirements = live.find((node) => node.kind === "product_requirements");
  const requirementsText = requirements ? (await readArtifactNode(requirements.id)).content : "";

  return [
    `Build the software described by this approved plan, against the requirements it cites. Work in the current directory.`,
    ``,
    ...(requirementsText ? [`--- REQUIREMENTS ---`, requirementsText, ``] : []),
    `--- PLAN ---`,
    planText,
    ``,
    `Frozen packet: ${packet?.node.contentHash ?? "unknown"}.`,
    `Targets: ${JSON.stringify(targets)}.`,
  ].join("\n");
}

/** What a worker's outcome means for its run, said in the ledger's terms. */
export function failureReason(outcome: Pick<BridgeOutcome, "available" | "exitStatus" | "stderrTail">): string | null {
  if (!outcome.available) return `The build worker is unavailable. ${outcome.stderrTail}`.trim();
  if (outcome.exitStatus === 0) return null;
  return outcome.exitStatus === null
    ? "The build worker ended without an exit status."
    : `The build worker exited ${outcome.exitStatus}.`;
}

/**
 * Fails a run whose worker did not succeed. A run that is no longer running
 * — cancelled or interrupted while the worker was up, which is the one way a
 * worker ends without succeeding on purpose — already has its terminal row,
 * and the guard would refuse a second one; that refusal is the expected end
 * of the race, not an error.
 */
async function settle(projectId: string, runId: string, outcome: BridgeOutcome): Promise<void> {
  const reason = failureReason(outcome);
  if (reason === null) return;
  const run = await readRun(runId, projectId);
  if (run?.state !== "running") return;
  try {
    await execute({
      type: "build.fail",
      actor: HOST_ACTOR,
      projectId,
      idempotencyKey: `${runId}:bridge-fail`,
      correlationId: newId.correlation(),
      payload: { runId, reason },
    });
  } catch (cause) {
    if (cause instanceof HostError && cause.code === "transition_refused") return;
    throw cause;
  }
}
