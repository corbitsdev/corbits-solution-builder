/**
 * Preparing a stage thread for the next draft.
 *
 * The thread itself is projected straight from the run (`stage-thread.ts`);
 * nothing here is written. What this decides is what the specialist actually
 * sees, which is deliberately not the transcript: a standing brief of the
 * directions that must keep holding, plus the turns recent enough to be
 * worth quoting verbatim.
 *
 * Compaction runs before a draft rather than after one, so the budget is
 * enforced against the prompt about to be sent rather than the one just sent.
 *
 * Compaction itself is a `Compactor` — `ContextStrategy<ConversationTurn[],
 * ConversationTurn[]>` from `@intx/types/runtime`, the type `@intx/agent`
 * registers on `env.compactors` for a director to invoke by name. A stage
 * specialist is a one-shot agent step in the run, not an `@intx/agent`
 * reactor session, so there is no director or reactor here to register it
 * with: `stageContext` runs the strategy directly, before the prompt is
 * rendered, the same way a reactor would run it on the director's behalf.
 *
 * The compacted brief has nowhere of its own to live — there is no marker
 * turn any more — so it travels as `provenance.brief` on the version the
 * round it prepared for produces, and the next round's brief is read back
 * off the current live version rather than off a separate row.
 */
import { complete } from "./inference.js";
import { threadTurns, type Quote, type StageTurn } from "./stage-thread.js";
import { database } from "./db.js";
import * as table from "./schema.js";
import { and, eq, isNull } from "drizzle-orm";
import type { Compactor, ConversationTurn, StrategyContext } from "@intx/types/runtime";

const COMPACTOR_SYSTEM = `You maintain the standing brief for one stage of a product-development thread.

You will be given the current brief (possibly empty) and the older turns of a conversation between a person and a specialist who drafts a document for them.

Rewrite the brief so it carries everything from those turns that must keep holding on every future revision: constraints, decisions, rejected directions, tone, things the person asked for repeatedly, and anything they said not to do.

Rules:
- Write imperative directions addressed to the specialist, one per line, prefixed with "- ".
- Keep a direction if it still constrains the document; drop it only if a later turn reversed it.
- Never invent a direction the person did not give.
- Do not summarise the document itself. Only what the person asked for.
- No preamble, no heading, no closing remark. Only the lines.`;

/**
 * How much verbatim conversation a revision prompt will carry before older
 * turns are folded into the brief. Characters rather than tokens because the
 * budget only has to be the right order of magnitude, and a character count is
 * something a reader of this file can verify.
 */
export const VERBATIM_BUDGET = 4000;

/** Renders one turn for the compactor's prompt, and for the draft prompt. */
function renderTurns(turns: StageTurn[]): string {
  return turns
    .map((turn) => {
      if (turn.role === "specialist") return `SPECIALIST: ${turn.body}`;
      const quoted = turn.quotes
        .map((entry) => `  (about this passage: "${entry.quote}")`)
        .join("\n");
      return `PERSON: ${turn.body}${quoted ? `\n${quoted}` : ""}`;
    })
    .join("\n\n");
}

/** A `StageTurn`, folded into `ConversationTurn`'s shape for the compactor. */
function toConversationTurns(turns: StageTurn[]): ConversationTurn[] {
  return turns.map((turn) => {
    const quoted = turn.quotes.map((entry) => `  (about this passage: "${entry.quote}")`).join("\n");
    const text = quoted ? `${turn.body}\n${quoted}` : turn.body;
    return {
      role: turn.role === "specialist" ? "assistant" : "user",
      content: [{ type: "text", text }],
      timestamp: Date.parse(turn.createdAt) || Date.now(),
    };
  });
}

function textOf(turn: ConversationTurn): string {
  return turn.content.map((block) => block.text ?? "").join("");
}

/**
 * The stage-brief compactor. Its input is the current brief (carried as a
 * leading `role: "system"` turn — `ContextStrategy` has no side channel for
 * "existing state", so the standing brief travels as just another turn) plus
 * the turns old enough to fold; its output is zero or one turn holding the
 * rewritten brief.
 */
export const stageBriefCompactor: Compactor = {
  name: "solutions-builder.stage-brief",
  version: "1",
  async apply(turns: ConversationTurn[], ctx: StrategyContext) {
    const briefTurns = turns.filter((turn) => turn.role === "system");
    const foldTurns = turns.filter((turn) => turn.role !== "system");
    const briefText = briefTurns.map(textOf).join("\n").trim() || "(empty)";
    const rendered = foldTurns
      .map((turn) => (turn.role === "assistant" ? `SPECIALIST: ${textOf(turn)}` : `PERSON: ${textOf(turn)}`))
      .join("\n\n");

    let body = "";
    try {
      const result = await complete({
        system: COMPACTOR_SYSTEM,
        prompt: ["--- CURRENT BRIEF ---", briefText, "", "--- OLDER TURNS TO FOLD IN ---", rendered].join(
          "\n",
        ),
        temperature: 0,
        maxTokens: 1200,
      });
      body = result.text.trim();
    } catch {
      // A failed compaction produces no output turn; the caller's fallback is
      // to send the turns verbatim rather than lose them.
      body = "";
    }

    const output: ConversationTurn[] = body
      ? [{ role: "system", content: [{ type: "text", text: body }], timestamp: Date.now() }]
      : [];

    return {
      output,
      record: {
        strategy: "solutions-builder.stage-brief",
        version: "1",
        parameters: { foldedTurns: foldTurns.length },
        reason: ctx.trigger,
        decisions: { producedBrief: body.length > 0 },
      },
    };
  },
};

export type StageContext = { brief: string | null; recent: StageTurn[] };

/**
 * The standing brief and the turns after it — what a revision prompt is built
 * from. The brief is read off `provenance.brief` of the stage's current live
 * version (null before there is one); "after it" is every projected turn
 * whose `resultNodeId` is not that version, i.e. everything the thread has
 * produced since — a version's own turn is the boundary, not part of what is
 * still pending.
 */
export async function pendingContext(
  projectId: string,
  stage: number,
): Promise<{ brief: string | null; pending: StageTurn[] }> {
  const all = await threadTurns(projectId, stage);

  const { db } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, projectId),
        eq(table.artifactNode.stage, stage),
        isNull(table.artifactNode.supersededByNodeId),
      ),
    );
  if (!node) return { brief: null, pending: all };

  const provenance = node.provenance as { brief?: string };
  const brief = provenance.brief ?? null;
  const index = all.findIndex((turn) => turn.resultNodeId === node.id);
  const pending = index === -1 ? all : all.slice(index + 1);
  return { brief, pending };
}

/**
 * The brief and the verbatim tail for the next draft, compacting first if the
 * thread has outgrown its budget.
 *
 * A failed compaction is not fatal. If the model call fails the older turns
 * stay uncompacted and are sent verbatim this time: a larger prompt is a much
 * better outcome than a draft that silently forgets what it was told.
 *
 * Nothing is written here: the brief this produces is only durable once the
 * round it prepares for actually drafts, as that version's own
 * `provenance.brief` — the caller (`stage-runs.ts`'s `requestDraft`) is what
 * persists it.
 */
export async function stageContext(args: {
  projectId: string;
  stage: number;
}): Promise<StageContext> {
  const { brief, pending } = await pendingContext(args.projectId, args.stage);
  const { fold, keep } = splitForCompaction(pending);
  if (fold.length === 0) return { brief, recent: keep };

  const briefTurn: ConversationTurn[] = brief
    ? [{ role: "system", content: [{ type: "text", text: brief }], timestamp: 0 }]
    : [];
  const result = await stageBriefCompactor.apply(
    [...briefTurn, ...toConversationTurns(fold)],
    { trigger: "pre-draft" },
  );
  const body = result.output.map(textOf).join("\n").trim();
  if (body.length === 0) return { brief, recent: pending };

  return { brief: body, recent: keep };
}

/** The conversation section of a draft prompt. Empty when there is none. */
export function renderStageContext(context: StageContext): string {
  const sections: string[] = [];
  if (context.brief) {
    sections.push(
      "--- STANDING DIRECTIONS FROM THE PERSON (these still apply) ---",
      context.brief,
    );
  }
  if (context.recent.length > 0) {
    sections.push("--- THE CONVERSATION SO FAR ---", renderTurns(context.recent));
  }
  return sections.join("\n\n");
}

/**
 * Splits pending turns into the ones to fold away and the ones to keep
 * verbatim, newest kept.
 *
 * The newest human turn is never folded: it is the instruction being acted on,
 * and summarising it would be summarising the request itself.
 */
export function splitForCompaction(turns: StageTurn[]): {
  fold: StageTurn[];
  keep: StageTurn[];
} {
  const size = (turn: StageTurn) =>
    turn.body.length + turn.quotes.reduce((total, entry) => total + entry.quote.length, 0);

  const keep: StageTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    // Always keep at least the most recent turn, whatever its size.
    if (keep.length > 0 && used + size(turn) > VERBATIM_BUDGET) {
      return { fold: turns.slice(0, index + 1), keep };
    }
    used += size(turn);
    keep.unshift(turn);
  }
  return { fold: [], keep };
}

export type { Quote };
