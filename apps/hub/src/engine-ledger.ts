/**
 * The command ledger: every committed command as one mail turn in a
 * per-project ledger session, on Interchange's own conversation primitives
 * (`hub-gaps.ts`'s `writeConversationTurn` / `listConversationTurns`) rather
 * than the `approval_record` / `audit_event` / `command_receipt` tables those
 * primitives duplicate.
 *
 * Nothing here decides whether a command is allowed — the guard already owns
 * that — and nothing here runs inside the transaction that committed it: the
 * mail write uses the shared single-writer connection and must not run while
 * a transaction is still open on it.
 */
import { PROJECT_LIFECYCLE_ID } from "@solutions-builder/app/workflows/project-lifecycle";
import { definitionIdFor, tenantId } from "./hub-client.js";
import {
  SPECIALIST_PRINCIPAL_ID,
  ensureAgentSession,
  ensureSpecialistPrincipal,
  ensureUserPrincipal,
  listConversationTurns,
  writeConversationTurn,
  type ConversationPart,
} from "./hub-gaps.js";
import { sha256 } from "./ids.js";
import type { CommandOutcome } from "./engine.js";
import { HOST_PRINCIPAL } from "./engine.js";
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

/** Records one committed command as a ledger mail turn. Call only after the transaction that committed it has returned. */
export async function recordCommand(entry: LedgerEntry): Promise<void> {
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
