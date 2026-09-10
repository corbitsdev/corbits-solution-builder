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

/** The command that most recently committed on this project, if any. */
export async function lastCommittedCommand(projectId: string): Promise<string | undefined> {
  const sessionId = await ledgerSessionIdFor(projectId);
  const parts = commandParts(await listConversationTurns(sessionId));
  const last = parts.at(-1);
  return last ? String(last.metadata!.command) : undefined;
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
