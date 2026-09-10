/**
 * The interview: a draft's questions, asked one at a time.
 *
 * Recording all of them up front and speaking one per turn is what makes this
 * a conversation rather than a form. It also means asking the next question
 * costs nothing — no model call, no new draft — so the person answers six
 * questions in six exchanges instead of six full redrafts.
 *
 * This is Builder's own table, not Interchange's: the platform's session/mail
 * model has no notion of "hold a batch of questions and ask them one at a
 * time", so unlike the turns themselves (see `host/hub/conversation.ts`) this
 * stays genuine product logic, in the smallest table that can hold it.
 * `answerMessageId` names a `session_mail`-backed turn id (the id
 * `appendHumanTurn` returns), not a foreign key the database enforces —
 * Interchange's tables are in a different schema, per the cross-schema rule
 * `host/db/migrate.ts` documents.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { database } from "./db.js";
import * as table from "./schema.js";
import { newId } from "./ids.js";

export async function recordQuestions(args: {
  projectId: string;
  branchId: string;
  stage: number;
  runId: string;
  sourceNodeId: string;
  questions: string[];
}): Promise<void> {
  const { db } = database();
  await db.transaction(async (tx) => {
    // A new draft's questions replace the old draft's: an unanswered question
    // about superseded text is not worth asking.
    await tx
      .update(table.stageQuestion)
      .set({ retiredAt: new Date() })
      .where(
        and(
          eq(table.stageQuestion.projectId, args.projectId),
          eq(table.stageQuestion.branchId, args.branchId),
          eq(table.stageQuestion.stage, args.stage),
          isNull(table.stageQuestion.retiredAt),
          isNull(table.stageQuestion.answerMessageId),
        ),
      );

    for (const [index, body] of args.questions.entries()) {
      await tx.insert(table.stageQuestion).values({
        id: newId.question(),
        projectId: args.projectId,
        branchId: args.branchId,
        stage: args.stage,
        runId: args.runId,
        sourceNodeId: args.sourceNodeId,
        ordinal: index,
        body,
      });
    }
  });
}

export type OpenQuestion = { id: string; body: string; ordinal: number; remaining: number };

/** The next question waiting on an answer, and how many follow it. */
export async function nextQuestion(
  projectId: string,
  branchId: string,
  stage: number,
): Promise<OpenQuestion | null> {
  const { db } = database();
  const rows = await db
    .select()
    .from(table.stageQuestion)
    .where(
      and(
        eq(table.stageQuestion.projectId, projectId),
        eq(table.stageQuestion.branchId, branchId),
        eq(table.stageQuestion.stage, stage),
        isNull(table.stageQuestion.retiredAt),
        isNull(table.stageQuestion.answerMessageId),
      ),
    )
    .orderBy(asc(table.stageQuestion.ordinal));

  const first = rows[0];
  if (!first) return null;
  return { id: first.id, body: first.body, ordinal: first.ordinal, remaining: rows.length - 1 };
}

export async function answerQuestion(questionId: string, messageId: string): Promise<void> {
  const { db } = database();
  await db
    .update(table.stageQuestion)
    .set({ answerMessageId: messageId })
    .where(eq(table.stageQuestion.id, questionId));
}

/** Drops every open question for a stage, when someone says to move on. */
export async function retireQuestions(
  projectId: string,
  branchId: string,
  stage: number,
): Promise<void> {
  const { db } = database();
  await db
    .update(table.stageQuestion)
    .set({ retiredAt: new Date() })
    .where(
      and(
        eq(table.stageQuestion.projectId, projectId),
        eq(table.stageQuestion.branchId, branchId),
        eq(table.stageQuestion.stage, stage),
        isNull(table.stageQuestion.retiredAt),
        isNull(table.stageQuestion.answerMessageId),
      ),
    );
}
