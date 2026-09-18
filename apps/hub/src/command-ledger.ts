/**
 * The command ledger: every committed command as one mail turn in a
 * per-project ledger session, on Interchange's own conversation primitives
 * (`hub-client.ts`'s `writeConversationTurn` / `listConversationTurns`) rather
 * than the `approval_record` / `audit_event` / `command_receipt` tables those
 * primitives duplicate.
 *
 * Nothing here decides whether a command is allowed — the guard already owns
 * that — and nothing here runs inside the transaction that committed it: the
 * mail write uses the shared single-writer connection and must not run while
 * a transaction is still open on it.
 */
import { LEDGER, type Command, type Stage } from "@solutions-builder/app/ledger";
import { PROJECT_LIFECYCLE_ID } from "@solutions-builder/app/workflows/project-lifecycle";
import { stageOfSignal } from "@solutions-builder/app/workflows/stage-loop";
import {
  SPECIALIST_PRINCIPAL_ID,
  definitionIdFor,
  ensureAgentSession,
  ensureSpecialistPrincipal,
  ensureUserPrincipal,
  listConversationTurns,
  tenantId,
  writeConversationTurn,
  type ConversationPart,
} from "./hub-client.js";
import { sha256 } from "./ids.js";
import type { CommandOutcome } from "./command-dispatch.js";
import { HOST_PRINCIPAL } from "./command-dispatch.js";
import type { RunMutation } from "./runs.js";

/** The `agent_session` id for a project's ledger, deterministic in the project id. */
export function ledgerSessionIdFor(projectId: string): Promise<string> {
  return sha256(`ledger:${projectId}`).then((digest) => `ses_${digest.slice(0, 24)}`);
}

async function ensureLedgerSession(projectId: string): Promise<string> {
  const definitionId = await definitionIdFor(PROJECT_LIFECYCLE_ID);
  if (!definitionId) {
    throw new Error(
      "No project-lifecycle workflow definition is seeded. seedWorkflows() must run before a command can be recorded.",
    );
  }
  await ensureSpecialistPrincipal(tenantId());
  const sessionId = await ledgerSessionIdFor(projectId);
  await ensureAgentSession({ sessionId, tenantId: tenantId(), definitionId, principalId: SPECIALIST_PRINCIPAL_ID });
  return sessionId;
}

export type LedgerEntry = {
  projectId: string;
  actorPrincipalId: string;
  authority: string | null;
  command: string;
  transitionId: string | null;
  correlationId: string;
  before: unknown;
  after: unknown;
  idempotencyKey: string;
  result: CommandOutcome;
  decision?: string;
  audienceName?: string | null;
  versions?: unknown;
  rationale?: string | null;
  assumptions?: unknown;
  stage?: number;
  runId?: string;
  /** The run set changes this command made; `runs.ts` folds them into the run record. */
  runs?: RunMutation[];
  /** A decision flag raised by this command (a route back, a material change). */
  flag?: DecisionFlag;
  /** A worker question raised by this command (build.wait_for_human). */
  question?: BuildQuestion;
  /** The answer this command gave to an open worker question (build.answer). */
  answer?: BuildAnswer;
  /** What a project.delete removed and what it kept, recorded with the deletion. */
  receipt?: RetentionReceipt;
  /** The human text this command opened with — `project.create`'s problem statement. */
  message?: string;
};

export type RetentionReceipt = {
  deletedAt: string;
  retainedArtifactNodeIds: string[];
  removedWorkspaces: string[];
};

export type BuildQuestion = {
  id: string;
  runId: string;
  /** The attempt that raised it; build.answer resumes exactly this origin. */
  originId: string;
  kind: string;
  prompt: string;
  scopeImpact: unknown;
};

export type BuildAnswer = {
  questionId: string;
  answer: string;
  grantedCapabilities: unknown;
};

/** Typed worker progress. Events are never approvals and never carry bytes. */
export type BuildEvent = {
  id: string;
  runId: string;
  idempotencyKey: string;
  cursor: number;
  type: string;
  severity: string;
  payload: unknown;
  occurredAt: string;
};

export type DecisionFlag = {
  id: string;
  runId: string;
  trigger: string;
  classification: string;
  evidence: unknown;
  chosenRoute: number | null;
  rejectedRoutes: unknown;
};

function summarize(entry: LedgerEntry): string {
  if (entry.decision) {
    const where = entry.audienceName ? ` (${entry.audienceName})` : "";
    const rationale = entry.rationale ? `: ${entry.rationale}` : "";
    return `${entry.decision}${where} on ${entry.command}${rationale}`;
  }
  return `Committed ${entry.command}.`;
}

/**
 * Where the ledger says a command leaves a run: the row's `to` state, and the
 * stage the row moves to — forward for an approval, back to the named target
 * for a route, into the build for a freeze, into delivery for accepted
 * evidence. The same table `admitGate` reads, so the ledger can never say a
 * gate went somewhere the run did not.
 */
function landing(command: Command, stage: Stage, payload: Record<string, unknown>): { state: string; stage: Stage; transition: string } | null {
  const row = LEDGER.find((entry) => entry.command === command && entry.from !== null);
  if (!row) return null;
  const target = typeof payload.targetStage === "number" ? (payload.targetStage as Stage) : stage;
  const toStage: Stage =
    command === "stage.approve"
      ? ((stage + 1) as Stage)
      : command === "build.freeze"
        ? 8
        : command === "build.accept_evidence"
          ? 9
          : row.to?.state === "backtracked"
            ? target
            : stage;
  return { state: row.to?.state ?? row.from!.state, stage: toStage, transition: row.id };
}

/**
 * The ledger mail a gate signal committed on the run should write. The
 * intent is thin — `command`, `runId`, and what the person said — so the
 * stage comes from the signal's name, the landing from the ledger row, the
 * actor from the `principalId` the hub stamped on delivery, and idempotency
 * from the `signalId` the runtime deduplicated on. Null when the signal is
 * not a stage's or names no run.
 */
export function ledgerEntryFromGateSignal(args: {
  readonly projectId: string;
  readonly command: Command;
  readonly payload: Record<string, unknown>;
  readonly signalId: string;
  readonly signalName: string;
}): LedgerEntry | null {
  const runId = typeof args.payload.runId === "string" && args.payload.runId.length > 0 ? args.payload.runId : null;
  const stage = stageOfSignal(args.signalName);
  if (!runId || stage === null) return null;
  const to = landing(args.command, stage, args.payload);
  if (!to) return null;
  const from = LEDGER.find((entry) => entry.command === args.command && entry.from !== null)!.from!;
  const result: CommandOutcome = {
    runId,
    stage: to.stage,
    state: to.state,
    transitionId: to.transition,
    replayed: false,
    delivery: "delivered",
  };
  const actor = typeof args.payload.principalId === "string" && args.payload.principalId.length > 0 ? args.payload.principalId : HOST_PRINCIPAL;
  return {
    projectId: args.projectId,
    actorPrincipalId: actor,
    authority: null,
    command: args.command,
    transitionId: to.transition,
    correlationId: args.signalId,
    before: { runId, stage, state: from.state },
    after: { runId, stage: to.stage, state: to.state },
    idempotencyKey: args.signalId,
    result,
    stage,
    runId,
    ...(typeof args.payload.decision === "string" ? { decision: args.payload.decision } : {}),
    ...(typeof args.payload.audienceName === "string" ? { audienceName: args.payload.audienceName } : {}),
    ...(args.payload.versions !== undefined ? { versions: args.payload.versions } : {}),
    ...(typeof args.payload.rationale === "string" ? { rationale: args.payload.rationale } : {}),
    ...(args.payload.assumptions !== undefined ? { assumptions: args.payload.assumptions } : {}),
    ...(typeof args.payload.message === "string" ? { message: args.payload.message } : {}),
  };
}

/** Records a gate the run committed as ledger mail; a receipt under the same signal id makes this a no-op. */
export async function recordGateFromSignal(args: Parameters<typeof ledgerEntryFromGateSignal>[0]): Promise<void> {
  const entry = ledgerEntryFromGateSignal(args);
  if (!entry) return;
  await recordCommand(entry);
}

/**
 * Records human-gate `SignalReceived` events that are already on the run and
 * have no ledger turn yet — the path a client signal over `/hub` takes, which
 * never calls `commandFrom`.
 */
export async function recordGatesFromRunEvents(
  projectId: string,
  events: readonly { type: string; body: Record<string, unknown> }[],
): Promise<void> {
  await recordAdmittedGates(projectId, [{ runId: "", awaited: new Set(), events }]);
}

/**
 * Records the admitted gate commands in per-run committed signal traffic —
 * the write-on-read path for client signals over `/hub`, which never call
 * `commandFrom`. The status read calls this with the events already in hand;
 * the parked names come from folding those same events.
 */
export async function recordAdmittedGates(projectId: string, runs: readonly RunSignalTraffic[]): Promise<void> {
  for (const event of selectAdmittedGateSignals(runs)) {
    const raw = event.body.payload;
    const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const command = typeof payload.command === "string" ? (payload.command as Command) : null;
    if (!command) continue;
    const signalId = typeof event.body.signalId === "string" ? event.body.signalId : "";
    const signalName = typeof event.body.signalName === "string" ? event.body.signalName : "";
    if (!signalId || !signalName) continue;
    await recordGateFromSignal({ projectId, command, payload, signalId, signalName });
  }
}

/**
 * The commands a committed run signal can carry, in ledger terms: every
 * command out of a stage, plus the build decisions a person takes on the
 * run — accept/fail on the evidence park, cancel/interrupt on the round.
 */
const GATE_SIGNAL_COMMANDS: ReadonlySet<string> = new Set([
  ...LEDGER.filter((row) => row.from?.kind === "stage").map((row) => row.command),
  "build.accept_evidence",
  "build.fail",
  "build.cancel",
  "build.interrupt",
]);

/** One run's committed signal traffic plus the signal names it still awaits. */
export type RunSignalTraffic = {
  readonly runId: string;
  readonly awaited: ReadonlySet<string>;
  readonly events: readonly { readonly seq?: number; readonly type: string; readonly body: Record<string, unknown> }[];
};

/**
 * Which committed `SignalReceived` events were admitted gate commands. A
 * parked signal (its name still awaited) was never consumed; a `SignalAwaited`
 * after the delivery re-parked the gate, so the delivered signal was refused
 * and a later delivery supersedes it. Signal ids dedupe the awaiter/relay
 * pair, which commit the same delivery twice under different names. Anything
 * here still skips its write when `recordCommand` finds the receipt, so a
 * gate recorded at delivery or by an earlier read is never written twice.
 */
export function selectAdmittedGateSignals(
  runs: readonly RunSignalTraffic[],
): { type: string; body: Record<string, unknown> }[] {
  const selected: { type: string; body: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const reArmed = new Map<string, number>();
    for (const event of run.events) {
      if (event.type !== "SignalAwaited") continue;
      const name = event.body.signalName;
      // Control-plane input parks reuse the await machinery on reserved
      // channels, never on a gate name; only a gate re-park refuses.
      if (typeof name !== "string" || event.body.parkKind === "input") continue;
      // A seq-less re-park cannot be ordered; the refusal wins and every
      // delivery of that name is skipped.
      reArmed.set(name, Math.max(reArmed.get(name) ?? -1, event.seq ?? Number.POSITIVE_INFINITY));
    }
    for (const event of run.events) {
      if (event.type !== "SignalReceived") continue;
      const name = event.body.signalName;
      if (typeof name !== "string" || run.awaited.has(name)) continue;
      // A seq-less event cannot prove it predates the re-park; without order
      // evidence the refusal wins and the delivery is skipped.
      if ((reArmed.get(name) ?? -1) > (event.seq ?? -1)) continue;
      const raw = event.body.payload;
      const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      if (typeof payload.command !== "string" || !GATE_SIGNAL_COMMANDS.has(payload.command)) continue;
      const signalId = event.body.signalId;
      if (typeof signalId !== "string" || !signalId || seen.has(signalId)) continue;
      seen.add(signalId);
      selected.push({ type: event.type, body: event.body });
    }
  }
  return selected;
}

/** Records one committed command as a ledger mail turn. Call only after the transaction that committed it has returned. A second call with the same idempotency key is a no-op, so a gate recorded at delivery is not written again from `commandFrom`. */
export async function recordCommand(entry: LedgerEntry): Promise<void> {
  if (await receiptFor(entry.projectId, entry.idempotencyKey)) return;
  const sessionId = await ensureLedgerSession(entry.projectId);
  // The mail is signed by the actor, so the actor needs a principal row to
  // hold a signing key against — `p_host`, the system actor, has never
  // needed one before this. Idempotent: a real user principal is untouched.
  await ensureUserPrincipal(tenantId(), entry.actorPrincipalId);

  const metadata: Record<string, unknown> = {
    kind: "command",
    command: entry.command,
    transitionId: entry.transitionId,
    authority: entry.authority,
    actorPrincipalId: entry.actorPrincipalId,
    correlationId: entry.correlationId,
    outcome: "committed",
    before: entry.before,
    after: entry.after,
    idempotencyKey: entry.idempotencyKey,
    result: entry.result,
  };
  if (entry.decision !== undefined) metadata.decision = entry.decision;
  if (entry.audienceName !== undefined) metadata.audienceName = entry.audienceName;
  if (entry.versions !== undefined) metadata.versions = entry.versions;
  if (entry.rationale !== undefined) metadata.rationale = entry.rationale;
  if (entry.assumptions !== undefined) metadata.assumptions = entry.assumptions;
  if (entry.stage !== undefined) metadata.stage = entry.stage;
  if (entry.runId !== undefined) metadata.runId = entry.runId;
  if (entry.runs !== undefined && entry.runs.length > 0) metadata.runs = entry.runs;
  if (entry.flag !== undefined) metadata.flag = entry.flag;
  if (entry.question !== undefined) metadata.question = entry.question;
  if (entry.answer !== undefined) metadata.answer = entry.answer;
  if (entry.receipt !== undefined) metadata.receipt = entry.receipt;
  if (entry.message !== undefined) metadata.message = entry.message;

  await writeConversationTurn({
    sessionId,
    tenantId: tenantId(),
    runId: entry.runId ?? "",
    role: "human",
    body: summarize(entry),
    fromPrincipalId: entry.actorPrincipalId,
    toPrincipalId: SPECIALIST_PRINCIPAL_ID,
    metadata,
    model: "human",
  });
}

function commandParts(parts: ConversationPart[]): ConversationPart[] {
  return parts.filter((part) => part.metadata?.kind === "command");
}

/** The prior result recorded under this idempotency key, if there is one. */
export async function receiptFor(
  projectId: string,
  idempotencyKey: string,
): Promise<CommandOutcome | null> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = commandParts(await listConversationTurns(sessionId));
  const match = parts.find((part) => part.metadata?.idempotencyKey === idempotencyKey);
  return match ? ({ ...(match.metadata!.result as CommandOutcome), replayed: true }) : null;
}

export type LedgerCommand = {
  id: string;
  command: string;
  actorPrincipalId: string;
  runs: unknown[];
  flag: DecisionFlag | null;
  question: BuildQuestion | null;
  answer: BuildAnswer | null;
  createdAt: string;
  /** The human text this command opened with, when it carried one. */
  message: string | null;
  /** Where the command left the run, when it recorded one. */
  after: unknown;
  result: CommandOutcome | null;
};

/**
 * Every committed command on this project as it was recorded, oldest first:
 * the turn's metadata whole, which is exactly what `recordCommand` wrote.
 * For carrying a project to another instance, where the ledger is replayed
 * entry by entry rather than re-decided.
 */
export async function ledgerEntries(projectId: string): Promise<{ startedAt: string; metadata: Record<string, unknown> }[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  return commandParts(await listConversationTurns(sessionId)).map((part) => ({
    startedAt: part.startedAt,
    metadata: part.metadata as Record<string, unknown>,
  }));
}

/** Every worker event recorded on this project, for every run, oldest first. */
export async function projectBuildEvents(projectId: string): Promise<BuildEvent[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = await listConversationTurns(sessionId);
  return parts
    .filter((part) => part.metadata?.kind === "build_event")
    .map((part) => {
      const { kind: _kind, ...event } = part.metadata as Record<string, unknown>;
      return event as unknown as BuildEvent;
    });
}

/** Every committed command on this project, oldest first, with the run mutations and flag it carried. */
export async function ledgerCommands(projectId: string): Promise<LedgerCommand[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = commandParts(await listConversationTurns(sessionId));
  return parts.map((part) => ({
    id: part.id,
    command: String(part.metadata!.command),
    actorPrincipalId: String(part.metadata!.actorPrincipalId ?? ""),
    runs: Array.isArray(part.metadata?.runs) ? (part.metadata!.runs as unknown[]) : [],
    flag: (part.metadata?.flag as DecisionFlag | undefined) ?? null,
    question: (part.metadata?.question as BuildQuestion | undefined) ?? null,
    answer: (part.metadata?.answer as BuildAnswer | undefined) ?? null,
    createdAt: part.startedAt,
    message: typeof part.metadata?.message === "string" ? part.metadata.message : null,
    after: part.metadata?.after ?? null,
    result: (part.metadata?.result as CommandOutcome | undefined) ?? null,
  }));
}

/** The decision flags raised on this project, newest first — the shape `projectDetail` returns. */
export async function projectFlags(
  projectId: string,
): Promise<(DecisionFlag & { projectId: string; createdAt: string; resolvedAt: null })[]> {
  const commands = await ledgerCommands(projectId);
  return commands
    .filter((command) => command.flag !== null)
    .map((command) => ({ ...command.flag!, projectId, createdAt: command.createdAt, resolvedAt: null }))
    .reverse();
}

/** Every `audience.decide` decision recorded for a run. */
export async function audienceDecisions(
  projectId: string,
  runId: string,
): Promise<{ audienceName: string; decision: string }[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = commandParts(await listConversationTurns(sessionId));
  return parts
    .filter((part) => part.metadata?.command === "audience.decide" && part.metadata?.runId === runId)
    .map((part) => ({
      audienceName: String(part.metadata?.audienceName ?? ""),
      decision: String(part.metadata?.decision ?? ""),
    }));
}

/** Every recorded approval-shaped command on this project, oldest first — the shape `projectDetail` returns to the web app. */
export async function projectApprovals(projectId: string): Promise<
  {
    id: string;
    /** The run the decision was recorded on: a stage reviewed again after a route back is a new run, and its review starts clean. */
    runId: string;
    stage: number;
    command: string;
    decision: string;
    audienceName: string | null;
    rationale: string | null;
    createdAt: string;
    versions: { versionId: string; contentHash: string }[];
  }[]
> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = commandParts(await listConversationTurns(sessionId));
  return parts
    .filter((part) => typeof part.metadata?.decision === "string")
    .map((part) => ({
      id: part.id,
      runId: String(part.metadata?.runId ?? ""),
      stage: Number(part.metadata?.stage ?? 0),
      command: String(part.metadata?.command ?? ""),
      decision: String(part.metadata?.decision ?? ""),
      audienceName: (part.metadata?.audienceName as string | null | undefined) ?? null,
      rationale: (part.metadata?.rationale as string | null | undefined) ?? null,
      createdAt: part.startedAt,
      versions: Array.isArray(part.metadata?.versions)
        ? (part.metadata!.versions as { versionId: string; contentHash: string }[])
        : [],
    }));
}

export type ProjectQuestion = BuildQuestion & {
  projectId: string;
  createdAt: string;
  answeredAt: string | null;
  answer: string | null;
  answeredBy: string | null;
  grantedCapabilities: unknown;
};

/**
 * The worker questions raised on this project, oldest first, each joined to
 * the build.answer turn that answered it. A question is the outcome of the
 * command that asked it; the answer is the outcome of the command that gave it.
 */
export async function projectQuestions(projectId: string): Promise<ProjectQuestion[]> {
  const commands = await ledgerCommands(projectId);
  const answers = new Map(
    commands
      .filter((command) => command.answer !== null)
      .map((command) => [command.answer!.questionId, command] as const),
  );
  return commands
    .filter((command) => command.question !== null)
    .map((command) => {
      const answered = answers.get(command.question!.id);
      return {
        ...command.question!,
        projectId,
        createdAt: command.createdAt,
        answeredAt: answered?.createdAt ?? null,
        answer: answered?.answer!.answer ?? null,
        answeredBy: answered?.actorPrincipalId ?? null,
        grantedCapabilities: answered?.answer!.grantedCapabilities ?? null,
      };
    });
}

/** The newest unanswered worker question on a run, if any. */
export async function openQuestion(projectId: string, runId: string): Promise<ProjectQuestion | undefined> {
  const questions = await projectQuestions(projectId);
  return questions.filter((question) => question.runId === runId && question.answeredAt === null).at(-1);
}

/**
 * Records one worker event as its own ledger turn. A bridge finishes after
 * the command that started it has already been recorded, and a mail turn is
 * never rewritten, so the event is a turn of its own on the same thread.
 */
export async function recordBuildEvent(projectId: string, event: BuildEvent): Promise<void> {
  const sessionId = await ensureLedgerSession(projectId);
  const existing = await buildEvents(projectId, event.runId);
  // At-least-once delivery is assumed; the idempotency key is the dedupe.
  if (existing.some((row) => row.idempotencyKey === event.idempotencyKey)) return;
  await ensureUserPrincipal(tenantId(), HOST_PRINCIPAL);
  await writeConversationTurn({
    sessionId,
    tenantId: tenantId(),
    runId: event.runId,
    role: "specialist",
    body: `${event.type}: ${event.severity}`,
    fromPrincipalId: HOST_PRINCIPAL,
    toPrincipalId: SPECIALIST_PRINCIPAL_ID,
    metadata: { kind: "build_event", ...event },
    model: "worker",
  });
}

/**
 * A turn of a stage's conversation, carried in from another instance. The
 * conversation at home is projected from the platform's workflow runs, which
 * do not travel; here it is kept as turns of the ledger's own session, so
 * the thread reads as it did and its open questions are still open.
 */
export type CarriedTurn = {
  id: string;
  role: "human" | "specialist";
  body: string;
  quotes: unknown[];
  resultNodeId: string | null;
  questions: string[] | null;
  createdAt: string;
};

const CARRIED_KIND = "carried_turn";

/** Records a stage's carried turns, once each: a turn already here by id is left as it is. */
export async function recordCarriedTurns(projectId: string, stage: number, turns: CarriedTurn[]): Promise<void> {
  if (turns.length === 0) return;
  const sessionId = await ensureLedgerSession(projectId);
  const already = new Set((await carriedTurns(projectId, stage)).map((turn) => turn.id));
  await ensureUserPrincipal(tenantId(), HOST_PRINCIPAL);
  for (const turn of turns) {
    if (already.has(turn.id)) continue;
    await writeConversationTurn({
      sessionId,
      tenantId: tenantId(),
      runId: "",
      role: turn.role,
      body: turn.body,
      fromPrincipalId: HOST_PRINCIPAL,
      toPrincipalId: SPECIALIST_PRINCIPAL_ID,
      metadata: { kind: CARRIED_KIND, stage, turn },
      model: "carried",
    });
  }
}

/** The turns carried in for one stage, oldest first. */
export async function carriedTurns(projectId: string, stage: number): Promise<CarriedTurn[]> {
  return (await allCarriedTurns(projectId)).filter((entry) => entry.stage === stage).map((entry) => entry.turn);
}

/** Every carried turn on the project, with its stage, oldest first. */
export async function allCarriedTurns(projectId: string): Promise<{ stage: number; turn: CarriedTurn }[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = await listConversationTurns(sessionId);
  return parts
    .filter((part) => part.metadata?.kind === CARRIED_KIND)
    .map((part) => ({ stage: Number(part.metadata!.stage), turn: part.metadata!.turn as CarriedTurn }))
    .sort((a, b) => a.turn.createdAt.localeCompare(b.turn.createdAt));
}

/**
 * One use of a model on the project's behalf: who ran it, on what, and what
 * the source reported. `tokens` is null where the source reported none.
 */
export type UsageRecord = {
  id: string;
  at: string;
  source: "round" | "host" | "illustration" | "worker";
  purpose: string;
  provider: string;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number } | null;
  images: number;
  calls: number;
  runId: string | null;
};

const USAGE_KIND = "inference_usage";

/** Records one use of a model as a turn of the project's ledger session. */
export async function recordUsage(projectId: string, record: UsageRecord): Promise<void> {
  const sessionId = await ensureLedgerSession(projectId);
  await ensureUserPrincipal(tenantId(), HOST_PRINCIPAL);
  await writeConversationTurn({
    sessionId,
    tenantId: tenantId(),
    runId: record.runId ?? "",
    role: "specialist",
    body: `${USAGE_KIND}: ${record.provider} ${record.model}`,
    fromPrincipalId: HOST_PRINCIPAL,
    toPrincipalId: SPECIALIST_PRINCIPAL_ID,
    metadata: { kind: USAGE_KIND, ...record },
    model: "usage",
  });
}

/** Every use of a model recorded on the project, oldest first. */
export async function usageRecords(projectId: string): Promise<UsageRecord[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = await listConversationTurns(sessionId);
  return parts
    .filter((part) => part.metadata?.kind === USAGE_KIND)
    .map((part) => {
      const { kind: _kind, ...record } = part.metadata as Record<string, unknown>;
      return record as unknown as UsageRecord;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The worker events recorded for a run, newest cursor first. */
export async function buildEvents(projectId: string, runId: string): Promise<BuildEvent[]> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = await listConversationTurns(sessionId);
  return parts
    .filter((part) => part.metadata?.kind === "build_event" && part.metadata.runId === runId)
    .map((part) => {
      const { kind: _kind, ...event } = part.metadata as Record<string, unknown>;
      return event as unknown as BuildEvent;
    })
    .sort((a, b) => b.cursor - a.cursor);
}
