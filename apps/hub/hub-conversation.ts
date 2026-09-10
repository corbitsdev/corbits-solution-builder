/**
 * The stage conversation, on Interchange's native session and mail.
 *
 * A stage thread is an `agent_session` keyed to that stage's seeded
 * `workflow_definition` (`solutions-builder.stage.N`); each human message and
 * each specialist reply is `session_mail`, direction inbound/outbound,
 * assembled and signed through `@intx/mime` rather than hand-built bytes.
 *
 * `session_mail` carries the wire record — what the platform's own mail model
 * expects to find — but it is not what this module reads a thread back from.
 * `inference_turn` / `turn_part` are written alongside every mail row and are
 * the read path: `turn_part.content` holds the turn's text and
 * `turn_part.metadata` carries what the platform has no column for (a turn's
 * quoted passages, and the artifact version a specialist turn produced).
 * Mail headers were the other candidate for that metadata, but
 * `MessageHeaders` is a closed, fixed set of `interchange-*` fields with no
 * extension slot — there is nowhere on the envelope to put "quotes" — while
 * `turn_part.metadata` is jsonb precisely for structured, per-part data no
 * fixed schema anticipated. A human turn is not itself a model inference, but
 * it is still given one `inference_turn` row (`model: "human"`) so both roles
 * read back through the same `turn_part` shape.
 *
 * Compaction is a `Compactor` (`ContextStrategy<ConversationTurn[],
 * ConversationTurn[]>` from `@intx/types/runtime`, the type `@intx/agent`
 * registers on `env.compactors`) rather than a `compactedAt` column plus a
 * standing-brief table — see `agent-conversation.ts`, which
 * owns the strategy itself. Its durable output is persisted here as an
 * ordinary outbound turn marked `metadata.kind === "brief"`: a marker turn in
 * the same mail/turn-part shape as any other, not a second kind of row.
 *
 * `stage_question` — the interview, one question at a time — has no native
 * equivalent and stays a small Builder table; see `host/store/questions.ts`.
 */
import { eq, type Column } from "drizzle-orm";
import { createDetachedSignatureWithSigner } from "@intx/crypto";
import { assembleMessage, assembleSignedContent, generateMessageId } from "@intx/mime";
import { hub } from "./hub-mount.js";
import { getWorkflowDefinitionId } from "./hub-workflows.js";
import { STAGE_WORKFLOW_ID } from "@solutions-builder/app/workflows/stage-loop";
import { LOCAL_TENANT } from "./projects.js";
import { newId, sha256 } from "./ids.js";

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

/** The address domain every local principal's mail is composed under. */
const MAIL_DOMAIN = "local.solutions-builder.invalid";

/**
 * The system identity that speaks a stage's specialist turns. One shared
 * identity across every stage and project: there is exactly one voice on the
 * other side of a stage thread, so one signing identity is what it is, not
 * nine.
 */
const SPECIALIST_PRINCIPAL_ID = "p_specialist";

function addressOf(principalId: string): string {
  return `${principalId}@${MAIL_DOMAIN}`;
}

type InsertHandle = {
  insert: (table: unknown) => { values: (row: unknown) => { onConflictDoNothing: () => Promise<unknown> } };
};

/**
 * Registers the specialist's platform identity, once. A `principal` row is
 * what a signing key and a session both attach to; `kind: "workflow"` is the
 * enum's own name for "a workflow speaks as this", which is exactly what a
 * stage specialist is.
 */
async function ensureSpecialistPrincipal(): Promise<void> {
  const { sql } = await import("drizzle-orm");
  const db = hub().db.db as unknown as { execute: (q: unknown) => Promise<unknown> };
  await db.execute(sql`
    INSERT INTO "public"."principal" ("id","tenant_id","kind","ref_id","status")
    VALUES (${SPECIALIST_PRINCIPAL_ID}, ${LOCAL_TENANT}, 'workflow', 'solutions-builder.specialist', 'active')
    ON CONFLICT ("id") DO NOTHING
  `);
}

/** Mints a principal's signing key if it does not already hold an active one. */
async function ensureSigningKey(principalId: string): Promise<void> {
  try {
    await hub().principalKeyStore.generate(principalId);
  } catch {
    // The partial unique index on (principalId, active) is what makes this
    // idempotent: a principal that already has an active key throws here,
    // which is exactly "nothing to do".
  }
}

/**
 * The `agent_session` id for a stage thread, deterministic in its three keys
 * so a second call finds the same session rather than starting another one.
 */
export function sessionIdFor(projectId: string, branchId: string, stage: number): Promise<string> {
  return sha256(`${projectId}:${branchId}:${stage}`).then((digest) => `ses_${digest.slice(0, 24)}`);
}

/**
 * Finds or creates the `agent_session` a stage thread lives on, keyed to that
 * stage's seeded workflow definition.
 */
async function ensureSession(args: {
  projectId: string;
  branchId: string;
  stage: number;
  principalId: string;
}): Promise<string> {
  const definitionId = await getWorkflowDefinitionId(
    LOCAL_TENANT,
    `${STAGE_WORKFLOW_ID}.${args.stage}`,
  );
  if (!definitionId) {
    throw new Error(
      `No workflow definition is seeded for stage ${args.stage}. seedWorkflows() must run before a stage conversation can open.`,
    );
  }

  const sessionId = await sessionIdFor(args.projectId, args.branchId, args.stage);
  const { sql } = await import("drizzle-orm");
  const db = hub().db.db as unknown as { execute: (q: unknown) => Promise<unknown> };
  await db.execute(sql`
    INSERT INTO "public"."agent_session" ("id","tenant_id","agent_id","principal_id","status")
    VALUES (${sessionId}, ${LOCAL_TENANT}, ${definitionId}, ${args.principalId}, 'active')
    ON CONFLICT ("id") DO NOTHING
  `);
  return sessionId;
}

/** Assembles and signs one mail message, using `@intx/mime` rather than hand-built bytes. */
async function buildRawMail(args: {
  sessionId: string;
  fromPrincipalId: string;
  toPrincipalId: string;
  body: string;
}): Promise<Uint8Array> {
  await ensureSigningKey(args.fromPrincipalId);
  const from = addressOf(args.fromPrincipalId);

  const signedContent = assembleSignedContent({ kind: "conversation", text: args.body });
  const signature = await createDetachedSignatureWithSigner(signedContent, (input) =>
    hub().principalKeyStore.sign(args.fromPrincipalId, input),
  );

  return assembleMessage(
    {
      from,
      to: [addressOf(args.toPrincipalId)],
      cc: undefined,
      date: new Date(),
      messageId: generateMessageId(from),
      subject: undefined,
      inReplyTo: undefined,
      references: undefined,
      mimeVersion: "1.0",
      interchangeType: "conversation.message",
      interchangeCorrelationId: undefined,
      interchangeTenantId: LOCAL_TENANT,
      interchangeAgentId: undefined,
      interchangeSessionId: args.sessionId,
      interchangeOfferingId: undefined,
      interchangeSchemaVersion: undefined,
      traceparent: undefined,
      tracestate: undefined,
    },
    signedContent,
    signature,
  );
}

/**
 * Writes one turn: the mail record the platform expects, and the
 * inference-turn/turn-part pair this module actually reads back from.
 * One transaction — a mail row with no turn-part would render blank, and a
 * turn-part with no mail row is not a turn the platform's own tools can see.
 */
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
}): Promise<string> {
  if (args.role === "specialist") await ensureSpecialistPrincipal();

  const sessionId = await ensureSession({
    projectId: args.projectId,
    branchId: args.branchId,
    stage: args.stage,
    principalId: args.principalId,
  });

  const fromPrincipalId = args.role === "human" ? args.principalId : SPECIALIST_PRINCIPAL_ID;
  const toPrincipalId = args.role === "human" ? SPECIALIST_PRINCIPAL_ID : args.principalId;
  const raw = await buildRawMail({ sessionId, fromPrincipalId, toPrincipalId, body: args.body });

  const mailId = newId.message();
  const turnId = newId.inferenceTurn();
  const partId = newId.turnPart();
  const now = new Date();
  const metadata: Record<string, unknown> = { role: args.role };
  if (args.quotes && args.quotes.length > 0) metadata.quotes = args.quotes;
  if (args.resultNodeId) metadata.resultNodeId = args.resultNodeId;
  if (args.questions) metadata.questions = args.questions;

  const { sessionMail, inferenceTurn, turnPart } = await import("@intx/db/schema");
  const db = hub().db.db as unknown as InsertHandle;

  // Sequential inserts, not one `db.transaction`: `hub().db.db` is a drizzle
  // binding over the same single-writer pglite connection the rest of the
  // host uses, and a caller elsewhere in the host may already be inside its
  // own transaction on that connection when this runs. Opening a second,
  // nested transaction here is exactly the shape that hangs.
  //
  // The order carries the safety instead. The read path is `inference_turn`
  // joined to `turn_part`, and the turn's words live on the part — those two
  // go first, so an interrupted write leaves either nothing or a whole,
  // readable turn. `session_mail` is the platform's mirror and goes last:
  // written first, a crash left a mail row asserting a message no reader
  // could see.
  await db
    .insert(inferenceTurn)
    .values({
      id: turnId,
      sessionId,
      // The Builder run this turn belongs to. No FK on this column — a
      // polymorphic reference the writer owns, per messages.ts's own
      // comment on the mirrored `sessionMail.runId`.
      runId: args.runId,
      tenantId: LOCAL_TENANT,
      model: args.role === "human" ? "human" : "stage-specialist",
      status: "completed",
      startedAt: now,
      endedAt: now,
    })
    .onConflictDoNothing();

  // The next position on this thread, read immediately before the write.
  // Two turns racing can still land on the same number; the sort breaks that
  // tie on the part id. What this removes is the far commoner case — a clock
  // that did not advance between two sequential writes.
  const existing = (await (db as unknown as SelectHandle)
    .select()
    .from(turnPart)
    .where(eq((turnPart as unknown as { sessionId: Column }).sessionId, sessionId))) as {
    ordinal?: number | null;
  }[];
  const ordinal = existing.reduce((high, row) => Math.max(high, (row.ordinal ?? 0) + 1), 0);

  await db
    .insert(turnPart)
    .values({
      id: partId,
      turnId,
      sessionId,
      type: "text",
      content: args.body,
      metadata,
      // A real position, not a constant. Ordering the thread by timestamp
      // alone leaves two turns written in the same millisecond in an
      // arbitrary order — and "the answer appears above the question" is the
      // one rendering fault a person reading a conversation cannot ignore.
      ordinal,
    })
    .onConflictDoNothing();
  await db
    .insert(sessionMail)
    .values({
      id: mailId,
      sessionId,
      runId: null,
      tenantId: LOCAL_TENANT,
      direction: args.role === "human" ? "inbound" : "outbound",
      status: "delivered",
      raw,
      createdAt: now,
    })
    .onConflictDoNothing();


  return partId;
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

type PartRow = {
  id: string;
  turnId: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  ordinal: number | null;
};
type TurnRow = { id: string; startedAt: Date };

type SelectHandle = {
  select: () => {
    from: (table: unknown) => { where: (predicate: unknown) => Promise<Record<string, unknown>[]> };
  };
};

/**
 * Every part on a session, oldest turn first, joined in memory to its turn's
 * start time (the two are separate selects because the opaque platform
 * schema stub gives no typed join here — the session's row count is small
 * enough that this costs nothing worth avoiding).
 *
 * `kind` surfaces `metadata.kind`, which is `"brief"` for a compaction marker
 * turn and absent for an ordinary one; callers that care filter on it.
 */
async function sessionTurns(
  sessionId: string,
): Promise<(StageTurn & { kind: string | undefined })[]> {
  const { inferenceTurn, turnPart } = await import("@intx/db/schema");
  const db = hub().db.db as unknown as SelectHandle;

  const partColumns = turnPart as unknown as { sessionId: Column };
  const turnColumns = inferenceTurn as unknown as { sessionId: Column };

  const [parts, turns] = await Promise.all([
    db.select().from(turnPart).where(eq(partColumns.sessionId, sessionId)) as unknown as Promise<
      PartRow[]
    >,
    db.select().from(inferenceTurn).where(eq(turnColumns.sessionId, sessionId)) as unknown as Promise<
      TurnRow[]
    >,
  ]);

  const startedAt = new Map(turns.map((turn) => [turn.id, turn.startedAt]));

  return parts
    .map((part) => {
      const metadata = part.metadata ?? {};
      const role = metadata.role === "specialist" ? "specialist" : "human";
      const quotes = Array.isArray(metadata.quotes) ? (metadata.quotes as Quote[]) : [];
      const resultNodeId = typeof metadata.resultNodeId === "string" ? metadata.resultNodeId : null;
      const questions = Array.isArray(metadata.questions)
        ? (metadata.questions as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : null;
      const when = startedAt.get(part.turnId) ?? new Date(0);
      return {
        id: part.id,
        role: role as "human" | "specialist",
        body: part.content ?? "",
        quotes,
        resultNodeId,
        questions,
        createdAt: when instanceof Date ? when.toISOString() : String(when),
        kind: metadata.kind as string | undefined,
        when,
        ordinal: part.ordinal ?? 0,
      };
    })
    // Time first, then the recorded position, then the id: every comparison
    // has a tiebreak, so the same thread always renders in the same order.
    .sort(
      (a, b) =>
        a.when.getTime() - b.when.getTime() ||
        a.ordinal - b.ordinal ||
        a.id.localeCompare(b.id),
    )
    .map(({ when: _when, ordinal: _ordinal, ...turn }) => {
      void _when;
      void _ordinal;
      return turn;
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
 * brief folds stay exactly where they are, on the session's mail; only the
 * next `pendingContext` call, which stops at the newest brief marker, treats
 * them as accounted for.
 */
export async function recordBrief(args: {
  projectId: string;
  branchId: string;
  stage: number;
  runId: string;
  body: string;
  actor: { principalId: string };
}): Promise<void> {
  await ensureSpecialistPrincipal();
  const sessionId = await ensureSession({
    projectId: args.projectId,
    branchId: args.branchId,
    stage: args.stage,
    principalId: args.actor.principalId,
  });
  const raw = await buildRawMail({
    sessionId,
    fromPrincipalId: SPECIALIST_PRINCIPAL_ID,
    toPrincipalId: args.actor.principalId,
    body: args.body,
  });

  const mailId = newId.message();
  const turnId = newId.inferenceTurn();
  const partId = newId.turnPart();
  const now = new Date();

  const { sessionMail, inferenceTurn, turnPart } = await import("@intx/db/schema");
  const db = hub().db.db as unknown as InsertHandle;

  // Sequential inserts, not one `db.transaction` — see the matching comment
  // in `writeTurn`: a nested transaction on the hub's shared single-writer
  // connection is a hang waiting to happen, not merely a slow query.
  await db
    .insert(inferenceTurn)
    .values({
      id: turnId,
      sessionId,
      runId: args.runId,
      tenantId: LOCAL_TENANT,
      model: "stage-compactor",
      status: "completed",
      startedAt: now,
      endedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(turnPart)
    .values({
      id: partId,
      turnId,
      sessionId,
      type: "text",
      content: args.body,
      metadata: { role: "specialist", kind: "brief" },
      ordinal: 0,
    })
    .onConflictDoNothing();
  await db
    .insert(sessionMail)
    .values({
      id: mailId,
      sessionId,
      runId: null,
      tenantId: LOCAL_TENANT,
      direction: "outbound",
      status: "delivered",
      raw,
      createdAt: now,
    })
    .onConflictDoNothing();

}
