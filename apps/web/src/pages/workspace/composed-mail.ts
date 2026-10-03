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

/** A stage's opening: the record the app sends the specialist when the stage starts, never something the person said. */
export function isStageOpening(message: Pick<ChatMessage, "author" | "subject">): boolean {
  return message.author === "me" && message.subject !== undefined && OPENING_SUBJECT.test(message.subject);
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
