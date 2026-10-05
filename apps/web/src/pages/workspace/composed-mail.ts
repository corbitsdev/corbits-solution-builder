/**
 * Mail the app composes in the person's name, and how the chat shows it
 * (#429). A stage's opening, a send-back cue, a requirement-ids block and
 * the material attached after an opening (#607) are written for the
 * specialist; read back in the chat as the person's
 * own words they are a page of hashes, a plan, or a marker. Alpha main's
 * prompt never reached the chat at all. Here each such mail folds behind
 * one line, and a marker a person never typed is not shown.
 *
 * Pure: the rule is testable without the thread, and the thread only
 * renders what this returns.
 */
import type { ChatMessage } from "../../stage-mail.ts";
import { stageName } from "../../components.jsx";
import { REQUIREMENTS_BLOCK_HEADING } from "@solutions-builder/app/requirements";
import { namedTogether, splitMaterialMail } from "./attached-material.ts";

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

/**
 * The fold for material attached after the opening (#607), or null for any
 * other body: the chat names the files and keeps what they say behind the
 * fold, the markers with it. For a body already known to be the person's.
 */
export function materialMailFold(body: string): ComposedFold | null {
  const material = splitMaterialMail(body);
  if (!material) return null;
  return { summary: "What the attached material says", body: material.material, lead: `Attached ${namedTogether(material.names) || "material"}.` };
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
    // Stage 1's opening is the person's own problem statement, nothing
    // composed ahead of it; a fold would hide their words behind a caption.
    if (opening[1] === "1") return null;
    return { summary: `What ${stageName(Number(opening[1]!))} opened with`, body: withoutSendBackRef(message.body), lead: null };
  }
  const material = materialMailFold(message.body);
  if (material) return material;
  // The supervisor's briefs (#695): the record of an ended attempt, and the
  // progress of a running one. The chat shows the line that says which; the
  // worker's turn lines and the record stay behind the fold.
  const brief = /^(Build attempt \d+ (?:is still running|has ended)[^\n]*)\n/.exec(message.body);
  if (brief) {
    return { summary: "What the supervisor was briefed with", body: message.body.slice(brief[0].length).trim(), lead: brief[1]! };
  }
  const isCue = SEND_BACK_REF.test(message.body);
  const hasIds = message.body.startsWith(REQUIREMENTS_BLOCK_HEADING);
  if (!isCue && !hasIds) return null;
  const stripped = withoutSendBackRef(message.body);
  if (!hasIds) return { summary: null, body: "", lead: stripped };
  const { ids, rest } = splitIdsBlock(stripped);
  return { summary: "The requirement ids, as minted", body: ids, lead: rest || null };
}
