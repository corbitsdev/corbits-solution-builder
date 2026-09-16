/**
 * The interview: a draft's questions, asked one at a time.
 *
 * The questions live where the specialist asked them — on its own turn in the
 * stage thread, as mail. Which one is open is read from the thread: the last
 * specialist turn that carried a list of questions starts a round, and every
 * human turn after it answers the next one. A new round (a fresh draft) ends
 * the old one by construction, so a question about superseded text is never
 * asked. A question the new draft repeats from an earlier round was answered
 * there, so it is skipped: without that, a model that re-emits answered
 * questions restarts the count every round and the interview never ends.
 * Nothing is stored beside the thread.
 */
import { nextOpenQuestion, threadTurns } from "./stage-thread.js";

export type OpenQuestion = { id: string; body: string; ordinal: number; remaining: number };

/** The next question waiting on an answer, and how many follow it. */
export async function nextQuestion(
  projectId: string,
  stage: number,
): Promise<OpenQuestion | null> {
  const turns = await threadTurns(projectId, stage);
  const open = nextOpenQuestion(turns);
  if (open === null) return null;
  return { id: `${open.openerId}:${open.ordinal}`, body: open.body, ordinal: open.ordinal, remaining: open.remaining };
}
