/**
 * The interview: a draft's questions, asked one at a time.
 *
 * The questions live where the specialist asked them — on its own turn in the
 * stage thread, as mail. Which one is open is read from the thread: the last
 * specialist turn that carried a list of questions starts a round, and every
 * human turn after it answers the next one. A new round (a fresh draft) ends
 * the old one by construction, so a question about superseded text is never
 * asked. Nothing is stored beside the thread.
 */
import { threadTurns } from "./hub-conversation.js";

export type OpenQuestion = { id: string; body: string; ordinal: number; remaining: number };

/** The next question waiting on an answer, and how many follow it. */
export async function nextQuestion(
  projectId: string,
  branchId: string,
  stage: number,
): Promise<OpenQuestion | null> {
  const turns = await threadTurns(projectId, branchId, stage);
  let round = -1;
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    const turn = turns[at]!;
    if (turn.role === "specialist" && turn.questions !== null) {
      round = at;
      break;
    }
  }
  if (round === -1) return null;
  const opener = turns[round]!;
  const questions = opener.questions ?? [];
  const answered = turns.slice(round + 1).filter((turn) => turn.role === "human").length;
  const body = questions[answered];
  if (body === undefined) return null;
  return {
    id: `${opener.id}:${answered}`,
    body,
    ordinal: answered,
    remaining: questions.length - answered - 1,
  };
}
