/**
 * The stage conversation, on Interchange's native session and mail.
 *
 * A stage thread is an `agent_session` keyed to that stage's seeded
 * `workflow_definition` (`solutions-builder.stage.N`); each human message and
 * each specialist reply is `session_mail`, direction inbound/outbound.
 *
 * The hub has no route that creates that session, writes that mail, or lists
 * `inference_turn` / `turn_part` — `GET /api/me/sessions` is a stub. The
 * durable writes live in `hub-gaps.ts` as named upstream asks; this file is
 * the product shape on top of them.
 *
 * Compaction's durable output is an ordinary outbound turn marked
 * `metadata.kind === "brief"`. The open question is read from the thread, not
 * a table; see `questions.ts`.
 */
import { definitionIdFor, tenantId } from "./hub-client.js";
import {
  SPECIALIST_PRINCIPAL_ID,
  ensureAgentSession,
  ensureSpecialistPrincipal,
  listConversationTurns,
  writeConversationTurn,
} from "./hub-gaps.js";
import { STAGE_WORKFLOW_ID } from "@solutions-builder/app/workflows/stage-loop";
import { sha256 } from "./ids.js";

export type Quote = { quote: string };

export type StageTurn = {
  id: string;
  role: "human" | "specialist";
  body: string;
  quotes: Quote[];
  resultNodeId: string | null;
  /**
   * The questions a specialist turn opened a round with, in the order they
   * are asked; null on every other turn. The thread is where the interview
   * lives, so this is where its questions are.
   */
  questions: string[] | null;
  createdAt: string;
};

/**
 * The `agent_session` id for a stage thread, deterministic in its three keys
 * so a second call finds the same session rather than starting another one.
 */
export function sessionIdFor(projectId: string, branchId: string, stage: number): Promise<string> {
  return sha256(`${projectId}:${branchId}:${stage}`).then((digest) => `ses_${digest.slice(0, 24)}`);
}

async function ensureSession(args: {
  projectId: string;
  branchId: string;
  stage: number;
  principalId: string;
}): Promise<string> {
  const definitionId = await definitionIdFor(`${STAGE_WORKFLOW_ID}.${args.stage}`);
  if (!definitionId) {
    throw new Error(
      `No workflow definition is seeded for stage ${args.stage}. seedWorkflows() must run before a stage conversation can open.`,
    );
  }
  const sessionId = await sessionIdFor(args.projectId, args.branchId, args.stage);
  await ensureAgentSession({
    sessionId,
    tenantId: tenantId(),
    definitionId,
    principalId: args.principalId,
  });
  return sessionId;
}

async function writeTurn(args: {
  projectId: string;
  branchId: string;
  stage: number;
  runId: string;
  role: "human" | "specialist";
  body: string;
  principalId: string;
  quotes?: Quote[];
  resultNodeId?: string | null;
  questions?: string[];
  kind?: "brief";
}): Promise<string> {
  if (args.role === "specialist") await ensureSpecialistPrincipal(tenantId());

  const sessionId = await ensureSession({
    projectId: args.projectId,
    branchId: args.branchId,
    stage: args.stage,
    principalId: args.principalId,
  });

  const fromPrincipalId = args.role === "human" ? args.principalId : SPECIALIST_PRINCIPAL_ID;
  const toPrincipalId = args.role === "human" ? SPECIALIST_PRINCIPAL_ID : args.principalId;
  const metadata: Record<string, unknown> = { role: args.role };
  if (args.quotes && args.quotes.length > 0) metadata.quotes = args.quotes;
  if (args.resultNodeId) metadata.resultNodeId = args.resultNodeId;
  if (args.questions) metadata.questions = args.questions;
  if (args.kind) metadata.kind = args.kind;

  return writeConversationTurn({
    sessionId,
    tenantId: tenantId(),
    runId: args.runId,
    role: args.role,
    body: args.body,
    fromPrincipalId,
    toPrincipalId,
    metadata,
    model: args.kind === "brief" ? "stage-compactor" : args.role === "human" ? "human" : "stage-specialist",
  });
}

export async function appendHumanTurn(args: {
  projectId: string;
  branchId: string;
  runId: string;
  stage: number;
  body: string;
  actor: { principalId: string };
  quotes?: Quote[];
}): Promise<string> {
  return writeTurn({
    projectId: args.projectId,
    branchId: args.branchId,
    stage: args.stage,
    runId: args.runId,
    role: "human",
    body: args.body,
    principalId: args.actor.principalId,
    ...(args.quotes ? { quotes: args.quotes } : {}),
  });
}

export async function appendSpecialistTurn(args: {
  projectId: string;
  branchId: string;
  runId: string;
  stage: number;
  body: string;
  actor: { principalId: string };
  /** The version this turn produced, when it produced one. */
  resultNodeId?: string | null;
  /** Set when this turn opens a round of questions, even an empty one. */
  questions?: string[];
}): Promise<string> {
  return writeTurn({
    projectId: args.projectId,
    branchId: args.branchId,
    stage: args.stage,
    runId: args.runId,
    role: "specialist",
    body: args.body,
    principalId: args.actor.principalId,
    ...(args.resultNodeId !== undefined ? { resultNodeId: args.resultNodeId } : {}),
    ...(args.questions !== undefined ? { questions: args.questions } : {}),
  });
}

async function sessionTurns(sessionId: string): Promise<(StageTurn & { kind: string | undefined })[]> {
  const parts = await listConversationTurns(sessionId);
  return parts.map((part) => {
    const metadata = part.metadata ?? {};
    const role = metadata.role === "specialist" ? "specialist" : "human";
    const quotes = Array.isArray(metadata.quotes) ? (metadata.quotes as Quote[]) : [];
    const resultNodeId = typeof metadata.resultNodeId === "string" ? metadata.resultNodeId : null;
    const questions = Array.isArray(metadata.questions)
      ? (metadata.questions as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : null;
    return {
      id: part.id,
      role,
      body: part.content,
      quotes,
      resultNodeId,
      questions,
      createdAt: part.startedAt,
      kind: typeof metadata.kind === "string" ? metadata.kind : undefined,
    };
  });
}

/** Every turn on a stage thread, oldest first — what the person reads. Never includes a brief marker. */
export async function threadTurns(
  projectId: string,
  branchId: string,
  stage: number,
): Promise<StageTurn[]> {
  const sessionId = await sessionIdFor(projectId, branchId, stage);
  const all = await sessionTurns(sessionId);
  return all
    .filter((turn) => turn.kind !== "brief")
    .map(({ kind: _kind, ...turn }) => {
      void _kind;
      return turn;
    });
}

/**
 * The standing brief and the turns after it — what a revision prompt is built
 * from. The brief is the most recent turn marked `metadata.kind === "brief"`;
 * everything strictly after it (by start time) is still verbatim.
 */
export async function pendingContext(
  projectId: string,
  branchId: string,
  stage: number,
): Promise<{ brief: string | null; pending: StageTurn[] }> {
  const sessionId = await sessionIdFor(projectId, branchId, stage);
  const all = await sessionTurns(sessionId);

  let briefIndex = -1;
  let brief: string | null = null;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (all[index]!.kind === "brief") {
      briefIndex = index;
      brief = all[index]!.body;
      break;
    }
  }

  const pending = all
    .slice(briefIndex + 1)
    .filter((turn) => turn.kind !== "brief")
    .map(({ kind: _kind, ...turn }) => {
      void _kind;
      return turn;
    });

  return { brief, pending };
}

/**
 * Records a compacted standing brief as a new marker turn, spoken by the
 * specialist identity. Nothing is deleted or rewritten: the raw turns this
 * brief folds stay exactly where they are; only the next `pendingContext`
 * call, which stops at the newest brief marker, treats them as accounted for.
 */
export async function recordBrief(args: {
  projectId: string;
  branchId: string;
  stage: number;
  runId: string;
  body: string;
  actor: { principalId: string };
}): Promise<void> {
  await writeTurn({
    projectId: args.projectId,
    branchId: args.branchId,
    stage: args.stage,
    runId: args.runId,
    role: "specialist",
    body: args.body,
    principalId: args.actor.principalId,
    kind: "brief",
  });
}
