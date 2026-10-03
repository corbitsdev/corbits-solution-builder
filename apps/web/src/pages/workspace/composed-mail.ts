/**
 * Mail the app composes in the person's name, and how the chat shows it
 * (#429). A stage's opening, a send-back cue and a requirement-ids block
 * are written for the specialist; read back in the chat as the person's
 * own words they are a page of hashes, a plan, or a marker. Alpha main's
 * prompt never reached the chat at all. Here each such mail folds behind
 * one line, and a marker a person never typed is not shown.
 *
 * Pure: the rule is testable without the thread, and the thread only
 * renders what this returns.
 */
import type { ChatMessage } from "../../stage-mail.ts";
import { personWordsIn } from "@solutions-builder/app/stage-prompt";
import { REQUIREMENTS_BLOCK_HEADING } from "@solutions-builder/app/requirements";
import { shortPromptHash } from "../../design-disposition.ts";

export type ComposedFold = {
  /** The one line the chat shows; null when nothing folds and only `lead` shows. */
  readonly summary: string | null;
  /** What opens under the summary, markers removed. */
  readonly body: string;
  /** A line shown outside the fold: the cue's or the ask's own sentence. */
  readonly lead: string | null;
};

const OPENING_SUBJECT = /^\[opening:[^\]]+:(\d+)\]/;
const SEND_BACK_REF = /\s*\[ref:[^\]]+\]\s*$/;

/** The send-back cue's sentence, its marker gone. */
export function withoutSendBackRef(body: string): string {
  return body.replace(SEND_BACK_REF, "").trimEnd();
}

/** A leading requirement-ids block and what follows it. */
function splitIdsBlock(text: string): { readonly ids: string; readonly rest: string } {
  const lines = text.split("\n");
  let end = lines.length;
  for (let at = 1; at < lines.length; at += 1) {
    if (lines[at]!.trim() === "" && at + 1 < lines.length && !lines[at + 1]!.startsWith("- ") && lines[at + 1]!.trim() !== "(None minted yet.)") {
      end = at;
      break;
    }
  }
  return { ids: lines.slice(0, end).join("\n").trim(), rest: lines.slice(end).join("\n").trim() };
}

/** A stage's opening: the record the app sends the specialist when the stage starts, never something the person said. */
export function isStageOpening(message: Pick<ChatMessage, "author" | "subject">): boolean {
  return message.author === "me" && message.subject !== undefined && OPENING_SUBJECT.test(message.subject);
}

const EVALUATOR_NOTES_TAG = "[evaluator-notes:";

/** The tag on a draft's request to its stage evaluator, keyed on the draft's text so one draft is judged once. */
export function evaluationTag(stage: number, draft: string): string {
  return `[evaluation:${stage}:${shortPromptHash(draft)}]`;
}

/** The subject of the evaluator's notes the app sends a specialist, keyed on the draft they judged so one draft's notes go once. */
export function evaluatorNotesSubject(stage: number, draft: string): string {
  return `${EVALUATOR_NOTES_TAG}${stage}:${shortPromptHash(draft)}]`;
}

/** The evaluator's notes, sent by the app: an event in the stage, never the person's words. */
export function isEvaluatorNotes(message: Pick<ChatMessage, "author" | "subject">): boolean {
  return message.author === "me" && message.subject?.startsWith(EVALUATOR_NOTES_TAG) === true;
}

/**
 * The fold for a person-authored message the app composed, or null for a
 * message the person wrote. Only `author === "me"` is ever inspected, so
 * nothing a specialist writes can be folded away by echoing a marker.
 */
export function composedMailFold(message: Pick<ChatMessage, "author" | "body" | "subject">): ComposedFold | null {
  if (message.author !== "me") return null;
  const opening = message.subject ? OPENING_SUBJECT.exec(message.subject) : null;
  if (opening) {
    return { summary: `What stage ${opening[1]!} opened with`, body: withoutSendBackRef(message.body), lead: null };
  }
  const isCue = SEND_BACK_REF.test(message.body);
  const hasIds = message.body.startsWith(REQUIREMENTS_BLOCK_HEADING);
  if (!isCue && !hasIds) return null;
  const stripped = withoutSendBackRef(message.body);
  if (!hasIds) return { summary: null, body: "", lead: stripped };
  const { ids, rest } = splitIdsBlock(stripped);
  return { summary: "The requirement ids, as minted", body: ids, lead: rest || null };
}

/** How a message the app composed shows in either chat view: hidden, or as one
 *  event line with the sent text folded beneath; null for an ordinary turn. */
export function appView(
  message: Pick<ChatMessage, "author" | "subject" | "body">,
): "hidden" | { readonly line: string; readonly detail: string } | null {
  if (isStageOpening(message)) return "hidden";
  if (isEvaluatorNotes(message)) {
    return { line: "Evaluator notes sent to the specialist", detail: personWordsIn(message.body)?.words ?? message.body };
  }
  return null;
}
