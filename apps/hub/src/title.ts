/**
 * A name for a project, from the problem it was opened with.
 *
 * Naming the thing itself — not the sentence somebody typed about it — is a
 * lifecycle concern: a naming agent step in the workflow (tracked in
 * CL-8347's follow-up) writes the real title as run output, which the client
 * folds. This module is the deterministic floor underneath that: a project
 * must open and show something whether or not a run has folded a name yet.
 */
const MAX_TITLE = 60;

/** The fallback, and the shape everything else is trimmed to. */
export function titleFromProblem(problem: string): string {
  const line = problem.trim().split("\n")[0]!.trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

/** Names a project from its opening problem statement. Currently the deterministic floor only. */
export async function nameProject(problem: string): Promise<string> {
  return titleFromProblem(problem);
}
