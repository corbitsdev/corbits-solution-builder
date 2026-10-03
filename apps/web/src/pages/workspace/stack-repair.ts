/**
 * The build plan's Stack block, carried forward when a revision drops it
 * (#437). The gate refuses a plan without a parseable "## Stack" block, and
 * a redraft after an answer tends to narrow scope and leave the block out,
 * or say the stack is unchanged. When an earlier version of the plan in the
 * same thread had a valid block, that section is written into the new draft
 * before the pane and the gate read it, the way the stage 3 choice is
 * repaired (`choice-repair.ts`). A plan no version ever gave a valid block
 * passes through, and the gate's banner stays the way out.
 */
import type { ChatMessage } from "../../stage-mail.ts";
import { parseStackRecord, stackSectionOf } from "@solutions-builder/app/stack";
import { isSubstantialDraft } from "./guidance.ts";

/** The heading the carried section is placed before when the draft has none. */
const AFTER_HEADINGS = [/^##\s+Components and interfaces\b/m, /^##\s+Data flow\b/m, /^##\s+Tasks in order\b/m];

/** `draft` with `section` as its Stack section: replacing a present but unusable one, else inserted where the plan's headings put it. */
export function withStackSection(draft: string, section: string): string {
  const present = stackSectionOf(draft);
  // A function replacement: a "$" in the block's own text is never a pattern.
  if (present) return draft.replace(present, () => section);
  // A "## Stack" heading with prose and no fence ("the stack is unchanged")
  // is replaced through to its next heading, so the plan never carries two.
  const bare = /^#{2,4}\s+Stack\b[^\n]*\n[\s\S]*?(?=^#{1,4}\s|(?![\s\S]))/m.exec(draft);
  if (bare) return `${draft.slice(0, bare.index)}${section}\n\n${draft.slice(bare.index + bare[0].length)}`;
  for (const heading of AFTER_HEADINGS) {
    const at = draft.search(heading);
    if (at !== -1) return `${draft.slice(0, at)}${section}\n\n${draft.slice(at)}`;
  }
  return `${draft.trimEnd()}\n\n${section}\n`;
}

/**
 * The stage 6 plan draft with a valid Stack block: the draft itself when it
 * has one, else the draft with the most recent earlier plan version's block
 * carried in, else the draft as it is.
 */
export function repairedStackDraft(stage: number, messages: readonly ChatMessage[], draft: ChatMessage | null): ChatMessage | null {
  if (stage !== 6 || !draft) return draft;
  if (parseStackRecord(draft.body)) return draft;
  const at = messages.findIndex((message) => message.id === draft.id);
  const before = at === -1 ? messages : messages.slice(0, at);
  const earlier = [...before]
    .reverse()
    .find((message) => message.author === "agent" && isSubstantialDraft(message.body) && parseStackRecord(message.body) !== null);
  if (!earlier) return draft;
  const section = stackSectionOf(earlier.body);
  if (!section) return draft;
  const body = withStackSection(draft.body, section);
  return parseStackRecord(body) ? { ...draft, body } : draft;
}

/**
 * A stage 6 plan kept in one artifact, with the Stack section of the newest
 * earlier version of that artifact that had a valid one carried in; null
 * when `content` has a valid block, or no earlier version gives one.
 */
export async function stackCarriedFromEarlierVersion(
  content: string,
  version: number,
  read: (version: number) => Promise<string>,
): Promise<string | null> {
  if (parseStackRecord(content)) return null;
  for (let earlier = version - 1; earlier >= 1; earlier -= 1) {
    const body = await read(earlier);
    const section = parseStackRecord(body) ? stackSectionOf(body) : null;
    if (!section) continue;
    const carried = withStackSection(content, section);
    return parseStackRecord(carried) ? carried : null;
  }
  return null;
}
