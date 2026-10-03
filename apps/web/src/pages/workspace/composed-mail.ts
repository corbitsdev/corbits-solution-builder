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
import { REQUIREMENTS_BLOCK_HEADING } from "@solutions-builder/app/requirements";

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

/** The stage a person-side message opened, or null when it opened none. */
function openedStage(message: Pick<ChatMessage, "author" | "subject">): number | null {
  if (message.author !== "me" || message.subject === undefined) return null;
  const opening = OPENING_SUBJECT.exec(message.subject);
  return opening ? Number(opening[1]) : null;
}

/** A stage's opening from stage 2 on: the approved record the app sends the
 *  specialist, never something the person said. Stage 1's opening is the
 *  person's own problem statement and stays theirs. */
export function isStageOpening(message: Pick<ChatMessage, "author" | "subject">): boolean {
  return (openedStage(message) ?? 0) > 1;
}

/**
 * The fold for a person-authored message the app composed, or null for a
 * message the person wrote. Only `author === "me"` is ever inspected, so
 * nothing a specialist writes can be folded away by echoing a marker.
 */
export function composedMailFold(message: Pick<ChatMessage, "author" | "body" | "subject">): ComposedFold | null {
  if (message.author !== "me") return null;
  const opening = message.subject ? OPENING_SUBJECT.exec(message.subject) : null;
  // Stage 1 opens with the person's own words, shown as they wrote them.
  if (opening && Number(opening[1]) > 1) {
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
