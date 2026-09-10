/**
 * A name for a project, from the problem it was opened with.
 *
 * The first line of what somebody typed is not a title — "I want an agent to
 * do cold emailing for me" is a sentence about themselves, and it is what the
 * breadcrumb, the project list and every later reference had to wear. One
 * short call turns it into the thing it is about.
 *
 * Falls back to the first line when no provider is connected or the call
 * fails: a project must open whether or not a model is reachable, and a
 * clumsy name is a far smaller failure than a create that refuses.
 */
import { complete } from "./inference.js";

const MAX_TITLE = 60;

/** The fallback, and the shape everything else is trimmed to. */
export function titleFromProblem(problem: string): string {
  const line = problem.trim().split("\n")[0]!.trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

export async function nameProject(problem: string): Promise<string> {
  const fallback = titleFromProblem(problem);
  if (problem.trim().length === 0) return fallback;

  const drafted = await complete({
    system:
      "You name things. Given what somebody wants built, reply with a short " +
      "noun phrase naming the thing itself — two to five words, no quotes, no " +
      "trailing punctuation, no preamble. Name the subject, not the person: " +
      '"Cold outreach agent", never "I want an agent". Reply with the name and nothing else.',
    prompt: problem.trim().slice(0, 2000),
    maxTokens: 32,
    temperature: 0.2,
    timeoutMs: 20_000,
  }).catch(() => null);

  if (!drafted) return fallback;

  // A model asked for a short phrase can still answer with a sentence, quotes,
  // or a preamble. Take the first line, strip what is obviously not the name,
  // and fall back rather than showing something worse than the plain first line.
  const cleaned = drafted.text
    .trim()
    .split("\n")[0]!
    .replace(/^["'`]+|["'`.]+$/g, "")
    .replace(/^(?:title|name)\s*[:\-—]\s*/i, "")
    .trim();

  if (cleaned.length === 0 || cleaned.length > MAX_TITLE) return fallback;
  return cleaned;
}
