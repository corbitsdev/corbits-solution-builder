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
import { stageName } from "../../stage-names.ts";
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
const ATTACHED_TAG = /\[attached:([^\]]+):(\d+)\]/g;
const SEND_BACK_REF = /\s*\[ref:[^\]]+\]\s*$/;

/** The stage artifact a message revises and its version, as the specialist's prompt reads them in a subject. */
export function artifactTag(artifact: { readonly id: string; readonly version: number }): string {
  return `[artifact:${artifact.id}:${String(artifact.version)}]`;
}

/** A project document the person attached to a message, pinned to the version they saw. */
export function attachedTag(document: { readonly artifactId: string; readonly version: number }): string {
  return `[attached:${document.artifactId}:${String(document.version)}]`;
}

/** None without tags, so the mailbox's own default subject applies. */
export function taggedSubject(tags: readonly string[], body: string): { readonly subject: string } | Record<string, never> {
  return tags.length > 0 ? { subject: `${tags.join(" ")} ${body.slice(0, 60)}` } : {};
}

export function attachedTags(subject: string | undefined): { readonly artifactId: string; readonly version: number }[] {
  return [...(subject ?? "").matchAll(ATTACHED_TAG)].map((tag) => ({ artifactId: tag[1]!, version: Number(tag[2]) }));
}

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
  // Stage 1 opens with the person's own words, shown as they wrote them.
  if (opening && Number(opening[1]) > 1) {
    return { summary: `What ${stageName(Number(opening[1]))} opened with`, body: withoutSendBackRef(message.body), lead: null };
  }
  const isCue = SEND_BACK_REF.test(message.body);
  const hasIds = message.body.startsWith(REQUIREMENTS_BLOCK_HEADING);
  if (!isCue && !hasIds) return null;
  const stripped = withoutSendBackRef(message.body);
  if (!hasIds) return { summary: null, body: "", lead: stripped };
  const { ids, rest } = splitIdsBlock(stripped);
  return { summary: "The requirement ids, as minted", body: ids, lead: rest || null };
}

/** Mail the app sends a specialist on its own account names itself in its
 *  subject: the chat shows it, and the reply `pairReplies` pairs with it, as
 *  one event line, without reading either body. */
const APP_SUBJECT = "[app:";
const APP_LINES = new Map<string, readonly [(about: string) => string, ((about: string) => string) | null]>([
  ["package", [(audience) => `Asked for the package for ${audience}`, (audience) => `Answered the package request for ${audience}`]],
  ["brief", [(attempt) => `Recorded attempt ${attempt} for the build supervisor`, null]],
  ["choice", [(approach) => `You chose ${approach}`, null]],
]);

type AppKind = "package" | "brief" | "choice";

/** `about` comes last, after any other tags, so it is read back whole. */
export function appSubject(kind: AppKind, about: string, tags: readonly string[] = []): string {
  return `${APP_SUBJECT}${kind}] ${[...tags, about].join(" ")}`;
}

/** What a person-side app subject names, by kind; null for any other message. */
function appSubjectOf(message: Pick<ChatMessage, "author" | "subject"> | undefined): { readonly kind: string; readonly about: string } | null {
  const subject = message?.author === "me" ? (message.subject ?? "") : "";
  if (!subject.startsWith(APP_SUBJECT)) return null;
  return { kind: subject.slice(APP_SUBJECT.length, subject.indexOf("]")), about: subject.slice(subject.lastIndexOf("] ") + 2) };
}

/** The stage 3 approach a message chose, or null. */
export function chosenApproach(message: Pick<ChatMessage, "author" | "subject">): string | null {
  const app = appSubjectOf(message);
  return app?.kind === "choice" ? app.about : null;
}

/** The line a message shows as instead of a bubble, or null. Only a
 *  person-side subject is read: nothing a specialist writes becomes one. */
export function appEventLine(message: Pick<ChatMessage, "author" | "subject">, answers: Pick<ChatMessage, "author" | "subject"> | undefined): string | null {
  const app = appSubjectOf(message.author === "me" ? message : answers);
  const lines = app ? APP_LINES.get(app.kind) : undefined;
  if (!app || !lines) return null;
  const [sent, answer] = lines;
  return message.author === "me" ? sent(app.about) : (answer?.(app.about) ?? null);
}

/** How a message the app composed shows in either chat view: hidden, as one
 *  event line (with the sent text folded beneath), or null for an ordinary turn. */
export function appView(
  message: Pick<ChatMessage, "author" | "subject" | "body">,
  answers?: Pick<ChatMessage, "author" | "subject">,
): "hidden" | { readonly line: string; readonly detail: string | null } | null {
  if (isStageOpening(message)) return "hidden";
  if (isEvaluatorNotes(message)) return { line: "Evaluator notes sent to the specialist", detail: message.body };
  const line = appEventLine(message, answers);
  return line ? { line, detail: null } : null;
}
