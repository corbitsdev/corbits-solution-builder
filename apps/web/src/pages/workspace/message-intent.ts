/**
 * What a message to the stage's specialist is asking for (#407): a
 * question, a redraft, or, in the Build plan stage, work that belongs to the
 * requirements author rather than the architect. Read off the words alone,
 * so it is wrong sometimes; it only decides who is asked first and what the
 * busy line says, never what the specialist is allowed to do.
 */
const REQUIREMENTS_DOC = /\b(prd|product requirements|requirements (document|doc|spec)|the requirements)\b/i;
const REWRITE_VERB = /\b(re-?write|re-?writ(e|ing)|revise|revision|update|redo|fix|change|edit|rework|regenerate|re-?draft|correct|amend|rewrit\w*)\b/i;
/** Asks about the requirements that are the architect's own: planning against them, citing them. */
const ARCHITECT_OWN = /\b(plan against|cite|citing|citations?|carry|attach|read|see|look at|against the (prd|requirements))\b/i;
const QUESTION = /\?\s*$|^\s*(can|could|would|should|what|why|how|which|where|when|who|does|do|is|are|did|will)\b/i;
const REDRAFT = /\b(revise|rewrite|redraft|redo|rework|change|update|fix|correct|amend|tighten|shorten|expand|add|remove|drop|replace|instead|rather)\b/i;

/** Whether a Build plan chat message is really for the requirements author. */
export function requirementsRequest(body: string): boolean {
  if (!REQUIREMENTS_DOC.test(body)) return false;
  if (ARCHITECT_OWN.test(body)) return false;
  return REWRITE_VERB.test(body);
}

/** The line the chat shows where a routed message would have been. */
export function routedLine(): string {
  return "Sent to the requirements author, whose document this is; its reply appears under Product requirements above.";
}

/** `status`: a brief the app sent the Build supervisor (#768), answered with a build status, not a draft of anything. */
export type AskKind = "question" | "redraft" | "draft" | "status";

const SUPERVISOR_BRIEF = /^Build attempt \d+ (?:is still running|has ended)\b/;

/** What the person asked for, from their words and whether a draft exists yet. */
export function askKind(body: string | null, hasDraft: boolean): AskKind {
  if (!body) return hasDraft ? "redraft" : "draft";
  if (SUPERVISOR_BRIEF.test(body)) return "status";
  if (QUESTION.test(body.trim())) return "question";
  if (hasDraft && REDRAFT.test(body)) return "redraft";
  return hasDraft ? "redraft" : "draft";
}

/** The specialists a person may send work to by name (#688), with the stage whose document each revises. */
const DELEGATES: readonly { readonly stage: number; readonly pattern: RegExp }[] = [
  { stage: 4, pattern: /\b(?:gui|ui|interface|experience|screen|mockup)\s+(?:builder|designer|design(?:er)?\s+specialist)\b|\bdesigner\b/i },
  { stage: 6, pattern: /\barchitect\b/i },
  { stage: 7, pattern: /\bestimator\b/i },
  { stage: 5, pattern: /\bpresentation\s+creator\b|\b(?:slides?|deck)\s+(?:builder|creator|maker)\b/i },
  { stage: 2, pattern: /\bconstraints\s+mapper\b/i },
  { stage: 1, pattern: /\bbrainstormer\b/i },
];
const DELEGATION_VERB = /\b(?:have|ask|tell|get|let|make)\s+(?:the\s+)?(?=\w)|\b(?:send|pass|hand)\s+(?:this|it|that)\s+(?:to|on\s+to)\s+(?:the\s+)?(?=\w)/i;

export type DelegationTarget = { readonly stage: number };

/**
 * Which other stage's specialist a message asks for work from: a
 * delegation verb ("have the…", "ask the…") followed by a specialist's
 * name, naming a stage other than the current one. Null otherwise.
 */
export function delegationTarget(body: string, currentStage: number): DelegationTarget | null {
  const verb = DELEGATION_VERB.exec(body);
  if (!verb) return null;
  const after = body.slice(verb.index + verb[0].length, verb.index + verb[0].length + 40);
  for (const delegate of DELEGATES) {
    if (delegate.pattern.test(after) && delegate.stage !== currentStage) return { stage: delegate.stage };
  }
  return null;
}
