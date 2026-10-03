/**
 * The project workflow (CL-8721) as a hub deployment: one native `loop`
 * workflow per project, holding real review references and deciding a
 * project's stage-by-stage progress. Deployed lazily, once per project, and
 * reused after that as long as it runs the current code -- the same
 * ensure-and-reuse discipline `specialist-deploy.ts`'s
 * `ensureSpecialistDeployment` uses for a stage specialist, with the same
 * exception: a live run on code that differs from the current render is
 * replaced (#51). The replacement is the dead-deployment revival path: a
 * fresh deployment is triggered and every decision the old run applied is
 * replayed onto it, in order, under the same ids, through the new code's
 * reducer. A decision the new rules refuse is recorded as refused by that
 * reducer and reported back, never dropped.
 *
 * Every run is triggered with the digest of the code it was deployed from
 * and a generation number, and the hub's own event log hands both back
 * (`RunStarted.trigger.payload`). That is what tells a reader which of two
 * live runs is the project's: the newer generation, once it has caught up.
 * The hub has no way to end a deployment (`POST /runs/:id/stop` is
 * unsupported upstream), so a superseded run stays placed; it is simply
 * never read or signalled again.
 */
import { ApiError, type Transport } from "@intx/hub-client";
import { SPECIALIST_BASE_DEPENDENCIES, type InferenceSourcePin } from "@solutions-builder/app/specialist-source";
import { isProjectStateSnapshot, type ProjectState } from "@solutions-builder/app/project-workflow/contracts";
import { assetsFor, workflowsFor, type HubDeployment, type HubTenant } from "./hub.js";
import { projectHome, projectTenants, type ProjectHome } from "./project-home.js";
import { isChatCapable } from "./resolved-catalog.js";
import { normalizedProjectId } from "./specialist-deploy.js";
import { treeDigest } from "./workflow-closure.js";
import { visibleCatalog, type VisibleCatalog } from "./visible-catalog.js";
import {
    deploymentHasEnded,
  deploymentIsLive,
  deploymentUsabilityFor,
  ensureWorkflowAsset,
  pollWhilePlacing,
  pushWorkflowSourceTree,
  waitForPushVisible,
  pinFor,
  RUN_ENDED_EVENTS,
  type PlacementWait,
  type SidecarCapability,
  type WorkflowGitPush,
} from "./workflow-deploy.js";

/** `sb-project-<projectId>-workflow`, normalized the same way
 *  `specialistAssetName` is. */
export function projectWorkflowAssetName(projectId: string): string {
  return `sb-project-${normalizedProjectId(projectId)}-workflow`;
}

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** See `specialist-deploy.ts`'s `pickDeployment`: a live deployment over an
 *  ended one, then the oldest `createdAt`, so every concurrent caller lands
 *  on the same winner. */
function pickDeployment(deployments: readonly HubDeployment[]): HubDeployment | undefined {
  return [...deployments].sort((a, b) => {
    const aLive = !ENDED_DEPLOYMENT_STATUSES.has(a.status);
    const bLive = !ENDED_DEPLOYMENT_STATUSES.has(b.status);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  })[0];
}

/** A loop-iteration child run id looks like `<runId>__<stepId>__<n>`; only a
 *  bare id (no `__`) is a top-level run this deployment was triggered as. */
export function topLevelRunIds(runIds: readonly string[]): string[] {
  return runIds.filter((id) => !id.includes("__"));
}

/**
 * The one top-level run every caller of `ensureProjectWorkflow` converges
 * on when several already exist for this deployment (two browsers racing
 * the first-ever trigger). Run ids are opaque, unordered-by-time tokens
 * (`generateId`) -- `listWorkflowRuns` carries no `createdAt` -- so "oldest"
 * is approximated by a stable, total order over the ids themselves: every
 * caller sees the same set and sorts it the same way, so every caller lands
 * on the same run regardless of which order the hub happened to list them
 * in on that particular call.
 */
function pickTopLevelRun(runIds: readonly string[]): string | undefined {
  return [...runIds].sort()[0];
}

/** A decision as a run applied it: the signal to deliver again, verbatim, to a run that has to catch up. */
/** A decision a run took: as a signal it received, replayable as it was
 *  sent; or as part of the snapshot it was started from (#299), held but
 *  with no signal of its own to send again. */
type ReceivedDecision = { readonly signalName: string; readonly signalId: string; readonly payload: unknown; readonly replayable: boolean };

/** The loop's decision signal; `project-workflow/workflow.ts`'s `PROJECT_DECISION_SIGNAL`, not imported to keep the definition's module out of the installer. */
const PROJECT_DECISION_SIGNAL_NAME = "project.decision";

/** The decisions a run was started holding, off the `snapshot` on its trigger (#299). */
function snapshotDecisionsOf(events: readonly { type: string; body: Record<string, unknown> }[]): ReceivedDecision[] {
  const started = events.find((event) => event.type === "RunStarted");
  const trigger = started?.body["trigger"];
  const init = isRecord(trigger) ? initOfTriggerPayload(trigger["payload"]) : undefined;
  const snapshot = isRecord(init) ? init["snapshot"] : undefined;
  if (!isProjectStateSnapshot(snapshot)) return [];
  return snapshot.decisions.map((record) => ({ signalName: PROJECT_DECISION_SIGNAL_NAME, signalId: record.decisionId, payload: undefined, replayable: false }));
}

/** The loop iterations of `runId` among `runIds`, by index: the order the loop applied decisions in. */
function iterationRunIds(runId: string, runIds: readonly string[]): string[] {
  return runIds
    .filter((id) => id.startsWith(`${runId}__`))
    .map((id) => ({ id, index: Number(id.slice(id.lastIndexOf("__") + 2)) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * Every decision the loop applied to `runId`, in the order it applied them:
 * the signals its iterations received, iterations by index, events by seq,
 * each signal once. A signal that reached the top-level run but no
 * iteration was queued and never applied, so it is not part of the run's
 * state and not part of its history.
 */
/**
 * What a reader remembers between polls, so a project's stage is not
 * re-derived from every iteration's event log every five seconds (#80). An
 * iteration that is not its run's newest has finished, and its log is
 * fixed; a run on an ended deployment is fixed whole. Only the newest
 * iteration of a live run can still take a signal, so only that one is
 * read again. The caller owns the memo: a page keeps one for its session,
 * a one-off call passes none and reads everything.
 */
export type DecisionMemo = {
  /** `<deploymentId>/<runId>`: an ended deployment's run, whole. */
  readonly runs: Map<string, readonly ReceivedDecision[]>;
  /** `<deploymentId>/<iterationRunId>`: one finished iteration's signals. */
  readonly iterations: Map<string, readonly ReceivedDecision[]>;
};

export function createDecisionMemo(): DecisionMemo {
  return { runs: new Map(), iterations: new Map() };
}

function signalsOf(events: readonly { seq: number; type: string; body: Record<string, unknown> }[]): ReceivedDecision[] {
  const received: ReceivedDecision[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type !== "SignalReceived") continue;
    const { signalName, signalId, payload } = event.body;
    if (typeof signalName !== "string" || typeof signalId !== "string") continue;
    received.push({ signalName, signalId, payload, replayable: true });
  }
  return received;
}

/** `settled`: the run's deployment has ended, so nothing about it changes again. */
async function appliedDecisions(
  workflows: ReturnType<typeof workflowsFor>,
  deploymentId: string,
  runId: string,
  memo?: DecisionMemo,
  settled = false,
): Promise<ReceivedDecision[]> {
  const runKey = `${deploymentId}/${runId}`;
  const remembered = settled ? memo?.runs.get(runKey) : undefined;
  if (remembered) return [...remembered];
  const iterations = iterationRunIds(runId, await workflows.runs(deploymentId));
  const newest = iterations[iterations.length - 1];
  const received: ReceivedDecision[] = [];
  const seen = new Set<string>();
  // What the run was started holding, off the snapshot on its trigger
  // (#299): read once per run, since a trigger never changes.
  const topKey = `${deploymentId}/${runId}#trigger`;
  let carried = memo?.iterations.get(topKey);
  if (!carried) {
    carried = snapshotDecisionsOf((await workflows.runEvents(deploymentId, runId)).events);
    memo?.iterations.set(topKey, carried);
  }
  for (const decision of carried) {
    seen.add(decision.signalId);
    received.push(decision);
  }
  for (const id of iterations) {
    const key = `${deploymentId}/${id}`;
    let signals = id === newest && !settled ? undefined : memo?.iterations.get(key);
    if (!signals) {
      signals = signalsOf((await workflows.runEvents(deploymentId, id)).events);
      if (memo && (id !== newest || settled)) memo.iterations.set(key, signals);
    }
    for (const decision of signals) {
      if (seen.has(decision.signalId)) continue;
      seen.add(decision.signalId);
      received.push(decision);
    }
  }
  if (memo && settled) memo.runs.set(runKey, received);
  return received;
}

/** The code a project workflow run was triggered on: the digest of the
 *  pushed tree it was deployed from together with the stage authorities it
 *  was triggered with (#165), and its generation -- one more than the run it
 *  replaced. Carried on the trigger payload beside `projectId` and
 *  `stages`, and read back off the run's own `RunStarted` event. */
export type ProjectWorkflowCode = { readonly digest: string; readonly generation: number };

/** What the trigger carries beside the code, folded into the digest so a
 *  live run triggered with other authorities than the caller names now is
 *  replaced the way a run on other code is: the reducer refuses every
 *  decision from a principal it was not told about, and only a fresh run
 *  can be told (#165). */
const TRIGGER_STAGES_PATH = "trigger/stages.json";

/** `null` for a run triggered before code was recorded on the trigger: its
 *  code is unknown, which the caller treats as not current. */
/** The init payload a run was triggered with: the JSON in the mail's text part for a real run, the payload itself in-process. */
function initOfTriggerPayload(payload: unknown): unknown {
  if (isRecord(payload) && Array.isArray(payload["parts"])) {
    const part = (payload["parts"] as unknown[]).find((p): p is { text: string } => isRecord(p) && typeof p["text"] === "string");
    if (!part) return undefined;
    try {
      return JSON.parse(part.text);
    } catch {
      return undefined;
    }
  }
  return payload;
}

function codeOfTriggerPayload(payload: unknown): ProjectWorkflowCode | null {
  // A REAL deployed run's trigger payload is the decoded mail that fired
  // it, with the JSON in a part's inline `text` (see `actions.ts`'s
  // `initProject`, which reads the same shape); an in-process run's is the
  // payload itself.
  const init = initOfTriggerPayload(payload);
  if (init === undefined) return null;
  const code = isRecord(init) ? init["code"] : undefined;
  if (!isRecord(code) || typeof code["digest"] !== "string" || typeof code["generation"] !== "number") return null;
  return { digest: code["digest"], generation: code["generation"] };
}

/** What one read of `runId`'s top-level log says: the code it was triggered
 *  on, off its `RunStarted` event, and whether it has ended, off a terminal
 *  event -- ended for good whatever its deployment's status says (#203). */
async function runFacts(
  workflows: ReturnType<typeof workflowsFor>,
  deploymentId: string,
  runId: string,
): Promise<{ code: ProjectWorkflowCode | null; ended: boolean }> {
  const { events } = await workflows.runEvents(deploymentId, runId);
  const started = events.find((event) => event.type === "RunStarted");
  const trigger = started?.body["trigger"];
  return {
    code: isRecord(trigger) ? codeOfTriggerPayload(trigger["payload"]) : null,
    ended: events.some((event) => TERMINAL_RUN_EVENTS.has(event.type)),
  };
}

/** One row of the reducer's ledger, as far as a replay needs to read it. */
type LedgerRecord = { readonly decisionId: string; readonly accepted: boolean; readonly reason?: unknown; readonly kind?: unknown; readonly stage?: unknown };

/** A step output's `inline:<json>` ref, decoded; `undefined` for any other ref. */
export function decodeInlineOutput(ref: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("inline:")) return undefined;
  try {
    return JSON.parse(ref.slice("inline:".length));
  } catch {
    return undefined;
  }
}

/**
 * The run's decision ledger as its reducer last wrote it: the `apply` step
 * output of the newest iteration that has one (the newest iteration is
 * usually parked, waiting; its carried-in state equals the previous
 * iteration's `apply` output). Null when no iteration has applied anything.
 */
/**
 * The state a run last wrote, whole: the newest iteration's `apply` output,
 * else the `hold` output the newest iteration parked with (a run revived
 * from a snapshot that has taken no decision yet holds only that). What a
 * fresh run is started from instead of replaying every decision (#299).
 * Null when no iteration has written a state this workflow recognises.
 */
async function latestStateOf(
  workflows: ReturnType<typeof workflowsFor>,
  deploymentId: string,
  runId: string,
): Promise<ProjectState | null> {
  const iterations = iterationRunIds(runId, await workflows.runs(deploymentId));
  for (const id of [...iterations].reverse()) {
    const { events } = await workflows.runEvents(deploymentId, id);
    for (const stepId of ["apply", "hold"]) {
      const completed = [...events].reverse().find((event) => event.type === "StepCompleted" && event.body["stepId"] === stepId);
      const output = decodeInlineOutput((completed?.body["output"] as { ref?: unknown } | undefined)?.ref);
      if (isProjectStateSnapshot(output)) return output;
    }
  }
  return null;
}

async function ledgerOf(
  workflows: ReturnType<typeof workflowsFor>,
  deploymentId: string,
  runId: string,
): Promise<readonly LedgerRecord[] | null> {
  const iterations = iterationRunIds(runId, await workflows.runs(deploymentId));
  for (const id of [...iterations].reverse()) {
    const { events } = await workflows.runEvents(deploymentId, id);
    const completed = [...events].reverse().find((event) => event.type === "StepCompleted" && event.body["stepId"] === "apply");
    const output = decodeInlineOutput((completed?.body["output"] as { ref?: unknown } | undefined)?.ref);
    const decisions = isRecord(output) ? output["decisions"] : undefined;
    if (!Array.isArray(decisions)) continue;
    return decisions.filter((row): row is LedgerRecord => isRecord(row) && typeof row["decisionId"] === "string" && typeof row["accepted"] === "boolean");
  }
  return null;
}

const TERMINAL_RUN_EVENTS = RUN_ENDED_EVENTS;
/** How long the hub may sit still on a placement this call waits for before the wait gives up. */
const REPLACEMENT_WAIT_MS = 45_000;

type ProjectRunCandidate = { readonly tenantId: string; readonly deployment: HubDeployment; readonly runId: string };

/** A project's workflow deployments in one of its tenants: its own, or the
 *  workspace for a project whose workflow was deployed before #29. */
type DeploymentGroup = { readonly tenantId: string; readonly deployments: readonly HubDeployment[] };

/** Every deployment that has a top-level run, oldest first across every
 *  group, with the run every caller picks for it. */
async function candidatesWithRuns(transport: Transport, groups: readonly DeploymentGroup[]): Promise<ProjectRunCandidate[]> {
  const byAge = groups
    .flatMap((group) => group.deployments.map((deployment) => ({ tenantId: group.tenantId, deployment })))
    .sort((a, b) => a.deployment.createdAt.localeCompare(b.deployment.createdAt));
  const candidates: ProjectRunCandidate[] = [];
  for (const { tenantId, deployment } of byAge) {
    const runId = pickTopLevelRun(topLevelRunIds(await workflowsFor(transport, tenantId).runs(deployment.id)));
    if (runId) candidates.push({ tenantId, deployment, runId });
  }
  return candidates;
}

/** The hub client for the tenant a candidate's deployment and run live in. */
function workflowsOf(transport: Transport, candidate: Pick<ProjectRunCandidate, "tenantId">): ReturnType<typeof workflowsFor> {
  return workflowsFor(transport, candidate.tenantId);
}

type ProjectRunState = {
  /** The run every reader converges on right now, or null when nothing holds the project's state. */
  readonly run: ProjectWorkflowDeployment | null;
  /** Whether `run` is on a deployment the hub can still place and no newer generation has replaced: false means it needs reviving. */
  readonly live: boolean;
  /** The code `run` was triggered on; null when unknown (a run from before code was recorded) or when there is no run. */
  readonly code: ProjectWorkflowCode | null;
  /** The live deployments of the newest generation with a run, oldest first. */
  readonly liveCandidates: readonly ProjectRunCandidate[];
  /** The newest generation any live run was triggered on; 0 when none carries one. */
  readonly generation: number;
  /** Every decision the dead and superseded runs took, in order, each once: what a live run must hold to be the project's. */
  readonly history: readonly ReceivedDecision[];
};

/**
 * Where a project's run is, across every deployment ever made for it.
 *
 * A host that gets killed outright, or stopped at all, leaves the hub
 * reporting the project's deployment ended -- failed, released -- and an
 * ended deployment is one the hub never places, fires or signals again.
 * The run parked there still holds the project's state, so it is still the
 * project's run until a live run has caught up with it: a live deployment
 * wins once it has received every decision the dead ones took. Reading a
 * live run that has not caught up is how a restart used to reset a project
 * to stage 1. A dead deployment whose run never took a decision holds no
 * history to replay, but it does hold the project's state -- its `init`
 * output, stage 1 -- so when nothing else does, the newest such run is
 * still the one read (#161): a card or a page opened after a host restart
 * shows the stage the project is at, not "unavailable". A caller that
 * deploys still deploys afresh in that case, since there is nothing to
 * replay.
 *
 * A live run of an older generation than another live run is superseded
 * (#51): the newer one was deployed to replace it with new code, and the
 * hub cannot end the old one. It counts exactly as a dead one does -- its
 * decisions are history the newer run must hold, and until the newer run
 * holds them the old run is still read, so an upgrade interrupted halfway
 * never shows a project at stage 1.
 *
 * Among several dead runs, the one holding the most decisions is read --
 * every replacement replays the whole history onto itself, so a newer dead
 * run holds everything an older one took plus whatever was decided after
 * it. Reading the oldest instead showed a stage the project had already
 * left (its approval landed on a later replacement), and the page then
 * re-opened that stage's review and offered its approval again, both
 * refused as `wrong_stage` (#77).
 */
async function projectRunState(transport: Transport, groups: readonly DeploymentGroup[], memo?: DecisionMemo): Promise<ProjectRunState> {
  const candidates = await candidatesWithRuns(transport, groups);
  const live: { candidate: ProjectRunCandidate; code: ProjectWorkflowCode | null }[] = [];
  // A deployment the hub still lists as placed whose run has already
  // ended: never signalled again, read for its history like a dead one,
  // and its generation still counts so the next deploy supersedes it (#203).
  const spent: { candidate: ProjectRunCandidate; code: ProjectWorkflowCode | null }[] = [];
  for (const candidate of candidates) {
    if (deploymentHasEnded(candidate.deployment)) continue;
    const { code, ended } = await runFacts(workflowsOf(transport, candidate), candidate.deployment.id, candidate.runId);
    if (ended) spent.push({ candidate, code });
    else live.push({ candidate, code });
  }
  const generation = Math.max(0, ...[...live, ...spent].map((entry) => entry.code?.generation ?? 0));
  const newest = live.filter((entry) => (entry.code?.generation ?? 0) === generation);
  const liveCandidates = newest.map((entry) => entry.candidate);
  const superseded = live.filter((entry) => (entry.code?.generation ?? 0) < generation);

  const history: ReceivedDecision[] = [];
  const known = new Set<string>();
  let fullest: { candidate: ProjectRunCandidate; code: ProjectWorkflowCode | null; held: number } | null = null;
  // The newest run that holds state but no decisions: read only when no run holds decisions.
  let newestDead: { candidate: ProjectRunCandidate; code: ProjectWorkflowCode | null } | null = null;
  const folded = [
    ...candidates.filter((entry) => deploymentHasEnded(entry.deployment)).map((candidate) => ({ candidate, code: null })),
    ...spent,
    ...superseded,
  ].sort((a, b) => a.candidate.deployment.createdAt.localeCompare(b.candidate.deployment.createdAt));
  for (const { candidate, code } of folded) {
    const decisions = await appliedDecisions(
      workflowsOf(transport, candidate),
      candidate.deployment.id,
      candidate.runId,
      memo,
      deploymentHasEnded(candidate.deployment),
    );
    if (decisions.length === 0) {
      newestDead = { candidate, code };
      continue;
    }
    // `>=`: candidates come oldest first, so a tie goes to the newer run.
    if (fullest === null || decisions.length >= fullest.held) fullest = { candidate, code, held: decisions.length };
    for (const decision of decisions) {
      if (known.has(decision.signalId)) continue;
      known.add(decision.signalId);
      history.push(decision);
    }
  }
  const asRef = (candidate: ProjectRunCandidate): ProjectWorkflowDeployment => ({
    deploymentId: candidate.deployment.id,
    runId: candidate.runId,
    tenantId: candidate.tenantId,
  });
  const state = { liveCandidates, generation, history };
  for (const { candidate, code } of newest) {
    if (history.length === 0) return { run: asRef(candidate), live: true, code, ...state };
    const held = new Set(
      (await appliedDecisions(workflowsOf(transport, candidate), candidate.deployment.id, candidate.runId, memo)).map((decision) => decision.signalId),
    );
    if (history.every((decision) => held.has(decision.signalId))) return { run: asRef(candidate), live: true, code, ...state };
  }
  if (fullest) return { run: asRef(fullest.candidate), live: false, code: fullest.code, ...state };
  if (newestDead) return { run: asRef(newestDead.candidate), live: false, code: newestDead.code, ...state };
  return { run: null, live: false, code: null, ...state };
}


async function pollUntil<T>(timeoutMs: number, intervalMs: number, read: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Whether a run's log, newest event last, shows it parked on its await:
 *  the only moment its single writer is idle, so the only moment a signal
 *  can be appended to that log without racing it (#188). */
function parkedOn(events: readonly { seq: number; type: string }[]): boolean {
  const newest = [...events].sort((a, b) => a.seq - b.seq).at(-1);
  return newest?.type === "SignalAwaited";
}

/** How the replay paces itself, how long it lets the run sit still, and
 *  how long it waits on the hub to place the target; all shortened by tests.
 *  `onProgress` hears each decision land (#295). */
type CatchUpOptions = {
  readonly pollMs?: number;
  readonly stallMs?: number;
  readonly placement?: PlacementWait;
  readonly onProgress?: (progress: EnsureProgress) => void;
};

/** What the ensure step is doing, for a caller that shows work in flight (#295). */
export type EnsureProgress =
  | { readonly phase: "waiting"; readonly detail: "placement" }
  | { readonly phase: "deploying" }
  | { readonly phase: "replaying"; readonly done: number; readonly total: number };

/** How long a run being replayed onto may go without writing an event, while
 *  neither parked nor ended, before it counts as lost: its child died (#189).
 *  The reducer a decision runs is quick, and everything slower writes events. */
const REPLAY_STALL_MS = 30_000;
/** How often the replay re-reads the run: a decision applies in well under
 *  a second on a local hub, and the reads are two requests per poll (#295). */
const REPLAY_POLL_MS = 400;

/**
 * A run that stopped taking decisions mid-replay: its log stopped growing
 * while it was neither parked on its await nor ended. The child dies on a
 * transition error without writing `RunFailed`, and the hub keeps listing
 * the deployment as live, so this is the only evidence there is (#189).
 */
export class ProjectWorkflowStalled extends Error {
  constructor(
    readonly run: ProjectWorkflowDeployment,
    readonly decisionId: string,
    stalledForMs: number,
  ) {
    super(`the project's workflow stopped applying decisions: run ${run.runId} made no progress for ${String(Math.round(stalledForMs / 1000))}s around decision ${decisionId}`);
    this.name = "ProjectWorkflowStalled";
  }
}

/**
 * Brings `target` up to `history`, one decision at a time: the loop takes
 * one signal per iteration, and signals delivered faster than that race
 * its log's single writer and fail the run. Each decision the run has not
 * applied is delivered again as the same signal under the same id, and the
 * next is not sent until the run has applied it AND parked again: the hub
 * appends a delivered signal to the run's log itself, and a signal sent
 * while the run's child is still writing the rest of its turn collides
 * with the child's next sequence number and kills the run (#188). The hub
 * treats a byte-identical signal under an id it already holds as a no-op,
 * and one it refuses as a conflict is checked against what the run applied
 * before it counts as a failure, so a replay interrupted halfway resumes
 * cleanly. A run whose log stops growing while it is neither parked nor
 * ended has lost its child; that is reported as `ProjectWorkflowStalled`
 * as soon as it is certain, not after the per-decision budget (#189).
 */
async function catchUp(transport: Transport, target: ProjectWorkflowDeployment, history: readonly ReceivedDecision[], options: CatchUpOptions = {}): Promise<void> {
  if (history.length === 0) return;
  const pollMs = options.pollMs ?? REPLAY_POLL_MS;
  const stallMs = options.stallMs ?? REPLAY_STALL_MS;
  const workflows = workflowsOf(transport, target);
  // Each finished iteration is read once: without the memo every poll
  // re-read every iteration's log, and a forty-decision replay took seven
  // seconds a decision and slowed as it went (#295).
  const memo = createDecisionMemo();
  options.onProgress?.({ phase: "waiting", detail: "placement" });
  // Placed, and its run started: a replacement reports `running` rather
  // than `deployed`, and either takes a signal once the run is on. Waited
  // for as long as the hub is visibly placing, not a fixed two minutes: a
  // fresh deployment queues behind the ones the hub is restoring after a
  // host start, and a clock counted from here ran out while the hub was
  // still working through them (#238).
  const placed = await pollWhilePlacing(
    workflows,
    (deployments) => {
      const found = deployments.find((entry) => entry.id === target.deploymentId);
      if (!found || deploymentHasEnded(found)) throw new Error("the project's workflow ended before its history could be replayed");
      return found.status === "deployed" || found.status === "running" ? true : null;
    },
    options.placement ?? {},
  );
  if (!placed) throw new Error("the project's workflow was not placed, so its history could not be replayed");
  const topLevel = async () => (await workflows.runEvents(target.deploymentId, target.runId)).events;
  const started = await pollUntil(120_000, pollMs, async () => ((await topLevel()).some((event) => event.type === "RunStarted") ? true : null));
  if (!started) throw new Error("the project's workflow run never started, so its history could not be replayed");
  const applied = async () => new Set((await appliedDecisions(workflows, target.deploymentId, target.runId, memo)).map((decision) => decision.signalId));
  const ended = (events: readonly { type: string }[]) => events.some((event) => TERMINAL_RUN_EVENTS.has(event.type));
  // Progress is the top-level log growing. Called on every read that finds
  // the run neither where the replay needs it nor ended. Counted only once
  // the run has parked at least once: before its first park it is still
  // starting up, and the namer it waits for (#201) can take longer than
  // the stall bound with nothing to show for it; the pre-send budget
  // bounds that wait instead.
  let newestSeq = -1;
  let movedAt = Date.now();
  let parkedOnce = false;
  const stillFor = (events: readonly { seq: number; type: string }[], decisionId: string) => {
    parkedOnce ||= events.some((event) => event.type === "SignalAwaited");
    if (!parkedOnce) return;
    const seq = Math.max(0, ...events.map((event) => event.seq));
    if (seq !== newestSeq) {
      newestSeq = seq;
      movedAt = Date.now();
      return;
    }
    const stalledForMs = Date.now() - movedAt;
    if (stalledForMs >= stallMs) throw new ProjectWorkflowStalled(target, decisionId, stalledForMs);
  };
  let held = await applied();
  let done = history.filter((decision) => held.has(decision.signalId)).length;
  options.onProgress?.({ phase: "replaying", done, total: history.length });
  for (const decision of history) {
    if (held.has(decision.signalId)) continue;
    // A decision held only by a snapshot has no signal to send again (#299).
    if (!decision.replayable) throw new Error(`the project's workflow cannot take decision ${decision.signalId} again: it exists only in a snapshot`);
    // Not before the run is parked: its writer is idle only then.
    const ready = await pollUntil(90_000, pollMs, async () => {
      const events = await topLevel();
      if (ended(events)) throw new Error("the project's workflow ended while its history was being replayed");
      if (parkedOn(events)) return true;
      stillFor(events, decision.signalId);
      return null;
    });
    if (!ready) throw new Error(`the project's workflow did not park before decision ${decision.signalId} could be replayed`);
    try {
      await workflows.signal(target.deploymentId, {
        runId: target.runId,
        signalName: decision.signalName,
        signalId: decision.signalId,
        payload: decision.payload,
      });
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    }
    // Landed: applied, and the run parked again after it (or ended on it).
    const landed = await pollUntil(90_000, pollMs, async () => {
      held = await applied();
      const events = await topLevel();
      if (held.has(decision.signalId) && (parkedOn(events) || ended(events))) return true;
      if (ended(events)) throw new Error("the project's workflow ended while its history was being replayed");
      stillFor(events, decision.signalId);
      return null;
    });
    if (!landed) throw new Error(`the project's workflow did not apply decision ${decision.signalId} while catching up`);
    done += 1;
    options.onProgress?.({ phase: "replaying", done, total: history.length });
  }
}

/** A replayed decision the run it came from had accepted, and the run it was replayed onto refused. */
export type ProjectWorkflowReplayRefusal = {
  readonly decisionId: string;
  readonly kind: string | null;
  readonly stage: number | null;
  readonly reason: string;
};

/** What a fresh run was brought up to: the run its history came from, how
 *  many decisions were replayed, and the ones the new code refused. */
export type ProjectWorkflowReplay = {
  readonly from: ProjectWorkflowDeployment;
  readonly replayed: number;
  readonly refused: readonly ProjectWorkflowReplayRefusal[];
  /** How the fresh run was brought up: started from `from`'s last state, or every recorded signal sent again (#299). */
  readonly via: "snapshot" | "signals";
};

/**
 * What the replay changed: every replayed decision the source run's ledger
 * shows accepted and the target run's ledger shows refused. Replay delivers
 * the same signals through the new code's reducer, which records a refusal
 * as a ledger row rather than dropping the decision, so this is read off
 * the two ledgers rather than guessed. A source ledger that cannot be read
 * counts every refused replayed decision, so a refusal is never hidden by
 * a read that failed.
 */
async function replayOutcome(
  transport: Transport,
  from: ProjectWorkflowDeployment,
  target: ProjectWorkflowDeployment,
  history: readonly ReceivedDecision[],
): Promise<ProjectWorkflowReplay> {
  const replayed = new Set(history.map((decision) => decision.signalId));
  // `from` and `target` may live in different tenants: a legacy run in the
  // workspace, revived in the project tenant (#29).
  const before = await ledgerOf(workflowsOf(transport, from), from.deploymentId, from.runId);
  const after = (await ledgerOf(workflowsOf(transport, target), target.deploymentId, target.runId)) ?? [];
  const acceptedBefore = new Set((before ?? []).filter((row) => row.accepted).map((row) => row.decisionId));
  const refused = after
    .filter((row) => replayed.has(row.decisionId) && !row.accepted && (before === null || acceptedBefore.has(row.decisionId)))
    .map((row) => ({
      decisionId: row.decisionId,
      kind: typeof row.kind === "string" ? row.kind : null,
      stage: typeof row.stage === "number" ? row.stage : null,
      reason: typeof row.reason === "string" ? row.reason : "refused",
    }));
  return { from, replayed: history.length, refused, via: "signals" };
}

/** The bytes a project workflow deploy needs: the compiled
 *  `workflow.js`/`actions.js`/`loops.js` `scripts/project-workflow-pack.ts`
 *  produces, fetched by the caller the same way `ClosureSource` fetches
 *  closure tarballs -- this package has no bundler and no `node:fs`. */
export type ProjectWorkflowSource = { readonly files: Readonly<Record<string, string>> };

export type ProjectWorkflowStageInput = {
  readonly stage: number;
  readonly authorizedPrincipalIds: readonly string[];
};

export type ProjectWorkflowDeployment = {
  readonly deploymentId: string;
  readonly runId: string;
  /** The tenant the deployment and its run live in: the project's own, or
   *  the workspace for a workflow deployed before #29 and still live. */
  readonly tenantId: string;
};

/** `ensureProjectWorkflow`'s answer: the run to read and signal, plus what
 *  was replayed onto it when it was brought up from another run's history. */
export type EnsuredProjectWorkflow = ProjectWorkflowDeployment & { readonly replay?: ProjectWorkflowReplay };

/** The asset a project workflow deploys into: a root workspace `package.json`,
 *  a member whose `interchange.workflow`/`actions`/`loops` point at the
 *  compiled entries, and the vendored `@intx/workflow` closure beside it. */
function renderProjectWorkflowSource(assetName: string, source: ProjectWorkflowSource, namer: InferenceSourcePin): Record<string, string> {
  const root = { name: `${assetName}-workspace`, version: "0.0.0", private: true, type: "module", workspaces: ["packages/*"] };
  const member = {
    name: assetName,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: SPECIALIST_BASE_DEPENDENCIES,
    interchange: { workflow: "./workflow.js", actions: "./actions.js", loops: "./loops.js" },
  };
  return {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    "packages/project/package.json": `${JSON.stringify(member, null, 2)}\n`,
    "packages/project/workflow.js": source.files["workflow.js"]!,
    "packages/project/actions.js": source.files["actions.js"]!,
    "packages/project/loops.js": source.files["loops.js"]!,
    "packages/project/namer-source.js": namerSourceModule(namer),
  };
}

/** One offering of a `GET /api/tenants/:id/models` row, as far as choosing the namer's model reads it. */
export type ResolvedOfferingPrice = {
  readonly offeringId: string;
  readonly plugin: string;
  readonly capabilities: readonly string[];
  readonly pricing: readonly { readonly currency: string; readonly inputTokenPrice: string | null; readonly outputTokenPrice: string | null }[];
};
export type ResolvedModelPrices = { readonly canonicalName: string; readonly offerings: readonly ResolvedOfferingPrice[] };

/**
 * The model the `name` step runs on: the cheapest chat-capable offering of
 * the leading offering's provider, by the tenant's own active prices. An
 * offering with no price on file is never assumed cheap, so with no prices
 * the name step runs on the leading offering, as every other step does.
 * Only offerings the deploy hands the hub (`deployable`) are considered.
 */
export function namerPin(lead: InferenceSourcePin, deployable: ReadonlySet<string>, models: readonly ResolvedModelPrices[]): InferenceSourcePin {
  const priceOf = (offering: ResolvedOfferingPrice, currency: string): number | null => {
    const row = offering.pricing.find((entry) => entry.currency === currency);
    const total = Number(row?.inputTokenPrice ?? NaN) + Number(row?.outputTokenPrice ?? NaN);
    return Number.isFinite(total) ? total : null;
  };
  const candidates = models.flatMap((model) =>
    model.offerings
      .filter((offering) => offering.plugin === lead.provider && deployable.has(offering.offeringId) && isChatCapable(offering.capabilities))
      .map((offering) => ({ model: model.canonicalName, offering })),
  );
  const leading = candidates.find((entry) => entry.model === lead.model);
  const currency = leading?.offering.pricing[0]?.currency ?? "USD";
  let best: { model: string; price: number } | null = null;
  for (const { model, offering } of candidates) {
    const price = priceOf(offering, currency);
    if (price !== null && (best === null || price < best.price)) best = { model, price };
  }
  return best ? { provider: lead.provider, model: best.model } : lead;
}

/** The namer's pin for `tenantId`, over the offerings a deploy there hands the hub. */
async function namerPinFor(transport: Transport, tenantId: string, catalog: VisibleCatalog): Promise<InferenceSourcePin> {
  const offerings = [...catalog.offerings].sort((a, b) => a.priority - b.priority);
  const lead = offerings[0] ? pinFor(catalog, offerings[0]) : undefined;
  if (!lead) throw new Error("connect a model provider before deploying the project workflow");
  const models = await transport.fetch<ResolvedModelPrices[]>("GET", `/api/tenants/${tenantId}/models`);
  return namerPin(lead, new Set(offerings.map((offering) => offering.id)), models);
}

/** The module `workflow.js` imports its namer pin from (see `namer-source.ts`). */
function namerSourceModule(pin: InferenceSourcePin): string {
  return `export const NAMER_SOURCE = ${JSON.stringify(pin)};\n`;
}

/** The file whose read-back proves a push is visible to the hub's deploy path. */
function pushProbePath(files: Record<string, string>): { path: string; content: string } {
  const path = "packages/project/actions.js";
  return { path, content: files[path]! };
}

/** What `ensureProjectWorkflow` may be told beyond its inputs. */
export type EnsureProjectWorkflowOptions = {
  /** How long the hub may go without placing anything before a wait on a
   *  placement gives up; the default suits a host start. */
  readonly replacementWaitMs?: number;
  /** How often a placement wait re-reads the hub; tests shorten it. */
  readonly placementPollMs?: number;
  /** How often a history replay re-reads the run it is bringing up; tests shorten it. */
  readonly replayPollMs?: number;
  /** How long a run being replayed onto may sit still, neither parked nor
   *  ended, before it counts as lost and is superseded; tests shorten it. */
  readonly replayStallMs?: number;
  /** Hears what the ensure step is doing, for a caller that shows work in flight (#295). */
  readonly onProgress?: (progress: EnsureProgress) => void;
  /** Rebuild the project's run from its recorded decisions rather than its
   *  last state: a fresh deployment replayed onto, whatever is live (#299). */
  readonly repair?: boolean;
  /** The project's opening statement, handed to a fresh run for its `name` step. */
  readonly problemStatement?: string;
};

type DeployContext = {
  readonly transport: Transport;
  readonly gitPush: WorkflowGitPush;
  /** The project's own tenant, where every deploy lands (#29). */
  readonly tenantId: string;
  readonly tenant: HubTenant;
  readonly projectId: string;
  readonly stages: readonly ProjectWorkflowStageInput[];
  readonly assetId: string;
  readonly assetName: string;
  readonly rendered: Record<string, string>;
  readonly code: ProjectWorkflowCode;
  readonly problemStatement: string | undefined;
  /** The state the fresh run starts from, when it revives a run (#299). */
  readonly snapshot?: ProjectState;
};

/**
 * Pushes the current render, deploys it, and returns a run on the result:
 * the deployment's first top-level run if a concurrent caller already
 * triggered one, else one triggered here with the project's stages and the
 * code it runs. `known` names every deployment that existed before the
 * push -- including a live one being replaced -- so only a deployment a
 * concurrent caller made meanwhile is reused rather than deployed beside.
 */
async function deployFreshRun(context: DeployContext, known: ReadonlySet<string>): Promise<ProjectWorkflowDeployment> {
  const { transport, tenantId, assetId, assetName, rendered } = context;
  const workflows = workflowsFor(transport, tenantId);
  const matching = (deployments: readonly HubDeployment[]) =>
    deployments.filter((deployment) => deployment.definitionAssetId === assetId && !known.has(deployment.id));

  const probe = pushProbePath(rendered);
  const commitSha = await pushWorkflowSourceTree(transport, tenantId, assetId, assetName, rendered, "Deploy project workflow", context.gitPush);
  await waitForPushVisible(transport, tenantId, assetId, probe.path, probe.content);

  // A concurrent caller may have deployed onto this asset while the push
  // above was in flight; re-check before deploying a second live one.
  let deployment = pickDeployment(matching(await workflows.deployments()));
  if (!deployment || !(await deploymentIsLive(transport, tenantId, deployment.id))) {
    // The project workflow runs no inference itself, but a deploy still
    // requires a non-empty offering chain -- the tenant's first offering is
    // pinned and simply never dispatched to.
    // The catalog this tenant can see, own rows or inherited (#30).
    const offerings = [...(await visibleCatalog(transport, context.tenant)).offerings].sort((a, b) => a.priority - b.priority);
    if (offerings.length === 0) {
      throw new Error("connect a model provider before deploying the project workflow");
    }
    const offeringIds = offerings.map((offering) => offering.id);
    const deployed = await workflows.deploy({
        source: { kind: "asset", assetId, package: { format: "source", commitSha, packageName: assetName } },
        entry: "./workflow.js",
        sourceOfferingIds: offeringIds,
        defaultSourceOfferingId: offeringIds[0]!,
      });
    deployment = pickDeployment(matching(await workflows.deployments())) ?? deployed;
  }

  // Reuse the first-ever top-level run triggered against this deployment,
  // the same way `deployment` above resolves to the one winner across
  // concurrent callers: list, and if none exists yet, trigger once and
  // re-list so every caller settles on the same (earliest) run id.
  const existingRun = pickTopLevelRun(topLevelRunIds(await workflows.runs(deployment.id)));
  if (existingRun) return { deploymentId: deployment.id, runId: existingRun, tenantId };
  const payload = {
    projectId: context.projectId,
    stages: context.stages,
    code: context.code,
    ...(context.problemStatement ? { problemStatement: context.problemStatement } : {}),
    ...(context.snapshot ? { snapshot: context.snapshot } : {}),
  };
  const fired = await workflows.trigger(deployment.id, { content: JSON.stringify(payload) });
  const afterTrigger = topLevelRunIds(await workflows.runs(deployment.id));
  return { deploymentId: deployment.id, runId: pickTopLevelRun(afterTrigger) ?? fired.runId, tenantId };
}

/**
 * A project's workflow deployments wherever they are: on the project
 * tenant's own asset, and -- for a project whose workflow was deployed
 * before #29 -- on the workspace's same-named asset. Each tenant's own
 * assets are listed, not the project tenant's inherited listing: that
 * listing shadows the workspace's asset the moment the project tenant
 * declares one of the same name, which `ensureWorkflowAsset` does before
 * this is read, and a project's whole history went missing that way (#195).
 */
async function projectWorkflowDeployments(
  transport: Transport,
  home: ProjectHome,
  assetName: string,
): Promise<{ groups: DeploymentGroup[]; everyDeployment: HubDeployment[] }> {
  const groups: DeploymentGroup[] = [];
  // Every deployment those tenants hold, this project's or not: what a
  // caller watches to tell that the hub is still placing (#79).
  const everyDeployment: HubDeployment[] = [];
  for (const tenantId of projectTenants(home)) {
    const own = await assetsFor(transport, tenantId).listOwn("workflow");
    const asset = own.find((entry) => entry.name === assetName && entry.tenantId === tenantId);
    if (!asset) continue;
    const deployments = await workflowsFor(transport, tenantId).deployments();
    everyDeployment.push(...deployments);
    groups.push({ tenantId, deployments: deployments.filter((deployment) => deployment.definitionAssetId === asset.id) });
  }
  return { groups, everyDeployment };
}

async function ensureProjectWorkflowOnce(
  transport: Transport,
  sidecar: SidecarCapability,
  source: ProjectWorkflowSource,
  gitPush: WorkflowGitPush,
  projectId: string,
  stages: readonly ProjectWorkflowStageInput[],
  vendoredWorkflowMemberFiles: Record<string, string>,
  options: EnsureProjectWorkflowOptions,
): Promise<EnsuredProjectWorkflow> {
  if (!sidecar.canPlaceSidecars) {
    throw new Error("no host is placing sidecars; cannot deploy a project workflow");
  }
  // The project's own tenant is where the workflow deploys (#29). A
  // workflow deployed before that, in the workspace, is reused while it
  // lives and runs the current code, and read for its history otherwise:
  // the revival below lands in the project tenant and replays every
  // decision onto it, which is how an existing project moves without
  // losing its stage.
  const home = await projectHome(transport, projectId);
  const { tenant, tenantId } = home;

  const assetName = projectWorkflowAssetName(projectId);
  const assetId = await ensureWorkflowAsset(transport, tenantId, assetName, `${projectId} project workflow`);
  const namer = await namerPinFor(transport, tenantId, await visibleCatalog(transport, tenant));
  const rendered = { ...renderProjectWorkflowSource(assetName, source, namer), ...vendoredWorkflowMemberFiles };
  const digest = await treeDigest({ ...rendered, [TRIGGER_STAGES_PATH]: JSON.stringify(stages) });

  const everywhere = async () => (await projectWorkflowDeployments(transport, home, assetName)).groups;
  // One call's own memo: the placement waits below re-read the project's
  // state every two seconds, and nothing about a finished iteration changes
  // between those reads.
  const memo = createDecisionMemo();
  const idsOf = (groups: readonly DeploymentGroup[], keep: (deployment: HubDeployment) => boolean = () => true) =>
    new Set(groups.flatMap((group) => group.deployments.filter(keep).map((deployment) => deployment.id)));
  const context = (generation: number, snapshot?: ProjectState): DeployContext => ({
    transport,
    gitPush,
    tenant,
    tenantId,
    projectId,
    stages,
    assetId,
    assetName,
    rendered,
    code: { digest, generation },
    problemStatement: options.problemStatement,
    ...(snapshot ? { snapshot } : {}),
  });

  // How long the hub may sit still before this waits no more on a
  // deployment it is still placing (#236).
  const placementWait: PlacementWait = {
    stallMs: options.replacementWaitMs ?? REPLACEMENT_WAIT_MS,
    ...(options.placementPollMs === undefined ? {} : { pollMs: options.placementPollMs }),
  };
  const replay: CatchUpOptions = {
    ...(options.replayPollMs === undefined ? {} : { pollMs: options.replayPollMs }),
    ...(options.replayStallMs === undefined ? {} : { stallMs: options.replayStallMs }),
    placement: placementWait,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
  const progress = options.onProgress ?? (() => {});
  // A live run not yet placed is waited for under the strip's clock, the
  // way a replay's placement is; one from before this host started is not
  // waited for (CL-9680) unless the host places it again (CL-9700).
  const usabilityOf = (tenantId: string, deploymentId: string, runId: string) => {
    progress({ phase: "waiting", detail: "placement" });
    return deploymentUsabilityFor(transport, tenantId, deploymentId, runId, placementWait, sidecar);
  };
  /**
   * Brings `target`, at `generation`, up to `history`. A run that stalls
   * mid-replay has lost its child (#189): it is superseded by a fresh run at
   * the next generation, brought up in its place, once. The stalled run
   * stays placed, since the hub cannot end a deployment, and is never read
   * or signalled again; `known` keeps the fresh deploy from reusing it.
   */
  const broughtUp = async (target: ProjectWorkflowDeployment, generation: number, history: readonly ReceivedDecision[]): Promise<ProjectWorkflowDeployment> => {
    try {
      await catchUp(transport, target, history, replay);
      return target;
    } catch (cause) {
      if (!(cause instanceof ProjectWorkflowStalled)) throw cause;
      const fresh = await (progress({ phase: "deploying" }), deployFreshRun)(context(generation + 1), new Set([...idsOf(groups), target.deploymentId]));
      await catchUp(transport, fresh, history, replay);
      return fresh;
    }
  };
  let groups = await everywhere();
  let state = await projectRunState(transport, groups, memo);
  /**
   * A fresh run in `from`'s place, at `generation`. Started from the state
   * `from` last wrote when that can be read (#299): nothing to replay, and the
   * run parks at the project's real stage the moment it starts. Replayed
   * from the recorded signals otherwise, and always on a repair, which is
   * the person asking not to trust the last state.
   */
  const revive = async (from: ProjectWorkflowDeployment, history: readonly ReceivedDecision[], generation: number, known: ReadonlySet<string>): Promise<EnsuredProjectWorkflow> => {
    const snapshot = options.repair ? null : await latestStateOf(workflowsOf(transport, from), from.deploymentId, from.runId);
    if (snapshot) {
      progress({ phase: "deploying" });
      const target = await deployFreshRun(context(generation, snapshot), known);
      return { ...target, replay: { from, replayed: snapshot.decisions.length, refused: [], via: "snapshot" } };
    }
    const unsendable = history.filter((decision) => !decision.replayable);
    if (unsendable.length > 0) {
      throw new Error(
        `the project's history cannot be replayed: ${String(unsendable.length)} of its ${String(history.length)} decisions exist only in a snapshot with no signal to send again, and no last state could be read`,
      );
    }
    progress({ phase: "deploying" });
    const target = await broughtUp(await deployFreshRun(context(generation), known), generation, history);
    return { ...target, replay: await replayOutcome(transport, from, target, history) };
  };

  if (state.run && state.live) {
    // Live by status is not usable yet (#236): a deployment can still be
    // placing, unplaced, and one whose run has ended cannot come back at
    // all. Handed back as it is, the page waited minutes for a placement
    // that never came. It is waited for within the placement bounds, then
    // either returned placed or replaced below.
    // A repair (#299) never reuses it: the person asked for a rebuild.
    const usability = state.code?.digest === digest && !options.repair ? await usabilityOf(state.run.tenantId, state.run.deploymentId, state.run.runId) : "usable";
    if (state.code?.digest === digest && !options.repair && usability === "usable") return state.run;
    // The live run is on other code than this render (#51): a reducer fix
    // that never reached this project, or a run from before code was
    // recorded. It is replaced the way a dead run is revived -- a fresh
    // deployment of the current code, brought up to every decision the
    // live run applied -- and superseded by generation, since the hub
    // cannot end it. Its own applied decisions are the whole history: it
    // held everything the runs before it took, or it would not be the run.
    // A run the hub could not bring back (#236) is replaced the same way.
    const from = state.run;
    const history = await appliedDecisions(workflowsOf(transport, from), from.deploymentId, from.runId, memo);
    return revive(from, history, state.generation + 1, idsOf(groups));
  }
  // A live run that has not caught up, or none: the project's history (if
  // any) is replayed onto the oldest live run, or onto a fresh one. A live
  // run that has caught up but runs other code is left to the next call,
  // which takes the replacement path above. A candidate the hub cannot
  // place, or whose run has ended (#236), is passed over for a fresh one.
  const candidate = state.liveCandidates[0];
  if (candidate && !options.repair && (await usabilityOf(candidate.tenantId, candidate.deployment.id, candidate.runId)) === "usable") {
    const target = await broughtUp({ deploymentId: candidate.deployment.id, runId: candidate.runId, tenantId: candidate.tenantId }, state.generation, state.history);
    return state.run && state.run.deploymentId !== target.deploymentId
      ? { ...target, replay: await replayOutcome(transport, state.run, target, state.history) }
      : target;
  }
  const from = state.run;
  // Every deployment that exists now is known: an ended one, one whose run
  // ended (#203), and one a newer generation superseded are all placed and
  // must not be reused as the fresh run's home.
  if (from) return revive(from, state.history, state.generation + 1, idsOf(groups));
  const target = await broughtUp(await (progress({ phase: "deploying" }), deployFreshRun)(context(state.generation + 1), idsOf(groups)), state.generation + 1, state.history);
  return target;
}

/**
 * Makes sure `projectId` has a live project workflow deployment running the
 * current code, with its ONE top-level run triggered, and hands back both
 * ids. Deploys/triggers lazily, once per project; on later calls, reuses
 * the live deployment and the already-triggered run rather than deploying
 * or triggering again -- unless that run is on other code than `source`
 * and `vendoredWorkflowMemberFiles` render to, in which case it is replaced
 * and its decisions replayed (see the module comment). Retries once on a
 * 409, the same way `ensureSpecialistDeployment` absorbs a concurrent
 * caller's race on the asset-create or push-token-mint step.
 */
export async function ensureProjectWorkflow(
  transport: Transport,
  sidecar: SidecarCapability,
  source: ProjectWorkflowSource,
  gitPush: WorkflowGitPush,
  projectId: string,
  stages: readonly ProjectWorkflowStageInput[],
  vendoredWorkflowMemberFiles: Record<string, string>,
  options: EnsureProjectWorkflowOptions = {},
): Promise<EnsuredProjectWorkflow> {
  const attempt = () => ensureProjectWorkflowOnce(transport, sidecar, source, gitPush, projectId, stages, vendoredWorkflowMemberFiles, options);
  try {
    return await attempt();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return await attempt();
    throw cause;
  }
}

/**
 * The same deployment/run `ensureProjectWorkflow` would reuse, without
 * deploying or triggering anything -- for a page that just needs to read the
 * project workflow's current stage (`project-view.ts`'s `loadProjectView`).
 * Null when the project has no workflow asset yet (a brand-new project the
 * workspace has not ensured yet), or no deployment on it has ever had a
 * top-level run triggered -- either of which means there is nothing here to
 * fold yet; the caller treats the project as still at stage 1 until
 * `StageWorkspace` ensures and triggers the workflow. A run on outdated
 * code is still returned here: only `ensureProjectWorkflow` knows the
 * current code, and replaces it.
 */
export async function findProjectWorkflow(transport: Transport, projectId: string, memo?: DecisionMemo): Promise<ProjectWorkflowDeployment | null> {
  const home = await projectHome(transport, projectId);
  const { groups } = await projectWorkflowDeployments(transport, home, projectWorkflowAssetName(projectId));
  if (groups.length === 0) return null;
  return (await projectRunState(transport, groups, memo)).run;
}
