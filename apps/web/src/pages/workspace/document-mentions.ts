/**
 * Documents that travel with a message (#345). Every specialist is its
 * own mail agent and sees only what it is sent, so when a request to a
 * companion names one of the stage's documents, the document's text is
 * attached under an "Attached" heading rather than left for it to ask for.
 * The stage's own conversation carries only the person's words; a document
 * reaches it when the person attaches it (`attach-documents.tsx`).
 */
export type StageDocument = {
  /** A stable key: `requirements`, `review:application`, … */
  readonly key: string;
  /** How the interface names it: "Product requirements", "Application review". */
  readonly label: string;
  /** Other ways a person refers to it, lower-case. */
  readonly aliases: readonly string[];
  readonly content: string;
};

export const ATTACHED_HEADING = "## Attached:";

/** The stage 6 requirements document, with the names people give it. */
export function requirementsDocument(content: string): StageDocument {
  return {
    key: "requirements",
    label: "Product requirements",
    aliases: ["prd", "product requirements", "requirements document", "the requirements", "requirements doc"],
    content,
  };
}

/** One panel review, by its reviewer. */
export function reviewDocument(reviewer: string, content: string): StageDocument {
  const who = reviewer.toLowerCase();
  return {
    key: `review:${who}`,
    label: `${reviewer} review`,
    aliases: [`${who} review`, `${who} reviewer`, `${who} reviewer's`, `${who} feedback`, `feedback from the ${who}`],
    content,
  };
}

const GENERIC_REVIEW = /\b(the )?(review|reviewer|reviewer's feedback|reviewer feedback|feedback)\b/i;

/**
 * Which of `documents` the message names, in the documents' order. A
 * generic "the review" or "the reviewer's feedback" means the one review
 * there is, when there is exactly one; several reviews need a name.
 */
export function mentionedDocuments(body: string, documents: readonly StageDocument[]): StageDocument[] {
  const text = body.toLowerCase();
  const named = documents.filter((doc) => doc.aliases.some((alias) => text.includes(alias)));
  if (named.length > 0) return named;
  const reviews = documents.filter((doc) => doc.key.includes(":"));
  if (reviews.length === 1 && GENERIC_REVIEW.test(body)) return reviews;
  return [];
}

/** The message with each named document appended once, under its own heading; unchanged when nothing is named or the text is already there. */
export function withAttachedDocuments(body: string, documents: readonly StageDocument[]): string {
  const attach = mentionedDocuments(body, documents).filter((doc) => doc.content.trim().length > 0 && !body.includes(doc.content.trim()));
  if (attach.length === 0) return body;
  return [body, ...attach.map((doc) => `---\n\n${ATTACHED_HEADING} ${doc.label}\n\n${doc.content.trim()}`)].join("\n\n");
}
