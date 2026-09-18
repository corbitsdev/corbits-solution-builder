/**
 * `nextOpenQuestion`: the pure fold over already-projected stage turns that
 * decides which of a specialist's asked questions is still open.
 *
 * The rest of this module's earlier contents — `projectStageThread` and its
 * supporting reads — folded a stage's *loop-era* iteration child runs (the
 * round step's `StepCompleted`/`SignalReceived`, the draft step's own
 * completion) into turns. Loops are gone (INTR-400/402/541; see
 * `./workflows/stage-loop.ts`): a stage's turns are now the chat section's
 * mail and its body's per-stage draft step outputs on the *anchor* run, not a
 * per-stage loop's iteration runs, so that fold no longer applies and is
 * deleted here rather than ported. Its replacement lives with whatever reads
 * the anchor run's events directly (see `apps/web/src/stage-thread.ts`).
 */
import type { Quote, StageTurn } from "./stage-prompt.js";

export type { Quote, StageTurn };

/**
 * The next open question over already-projected turns: the last specialist
 * turn that carried a list of questions starts a round, and every human turn
 * after it answers the next one. A question an earlier round asked counts as
 * asked only when it was answered there — the human turns before the next
 * round started — so a question a `revise:true` round abandoned (the reply
 * route forces those to `final`, dropping the rest of the queue) is asked
 * again when the next draft re-emits it. When nothing fresh remains there is
 * no open question.
 */
/** One question with case and spacing flattened, so a re-emitted repeat matches the round that asked it. */
function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
}

export function nextOpenQuestion(turns: readonly StageTurn[]): {
  readonly body: string;
  readonly ordinal: number;
  readonly remaining: number;
  readonly openerId: string;
} | null {
  let round = -1;
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (turns[at]!.role === "specialist" && turns[at]!.questions !== null) {
      round = at;
      break;
    }
  }
  if (round === -1) return null;
  const opener = turns[round]!;
  const askedBefore = new Set<string>();
  const openers: number[] = [];
  for (let at = 0; at <= round; at += 1) {
    if (turns[at]!.role === "specialist" && turns[at]!.questions !== null) openers.push(at);
  }
  for (let roundIndex = 0; roundIndex + 1 < openers.length; roundIndex += 1) {
    const start = openers[roundIndex]!;
    const end = openers[roundIndex + 1]!;
    const answered = turns.slice(start + 1, end).filter((turn) => turn.role === "human").length;
    for (const asked of (turns[start]!.questions ?? []).slice(0, answered)) askedBefore.add(normalizeQuestion(asked));
  }
  const fresh = (opener.questions ?? []).filter((asked) => !askedBefore.has(normalizeQuestion(asked)));
  const answered = turns.slice(round + 1).filter((turn) => turn.role === "human").length;
  const body = fresh[answered];
  if (body === undefined) return null;
  return { body, ordinal: answered, remaining: fresh.length - answered - 1, openerId: opener.id };
}

