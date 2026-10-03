/**
 * Material a person attaches after a stage has opened (#607).
 *
 * A specialist reads only its mail. The person's material goes in the
 * stage's opening (`approved-chain.ts`), and an opening is sent once, onto
 * an empty thread: a file attached after that was saved, shown as attached,
 * and sent to nobody. It is mailed instead, in the same form the opening
 * carries it, once per stage thread.
 *
 * What is owed is read off the record rather than remembered: a file made
 * after the thread's first mail, whose marker no mail of the person's
 * carries. So a reload never repeats a file, a failed send is owed again,
 * and a stage that is sent back to is handed what was attached while the
 * project was further on. Pure, so the rule is testable without the hook:
 * the hook only sends what this returns.
 */
import { personWordsIn, renderInputs, type Inputs } from "@solutions-builder/app/stage-prompt";
import type { ChatMessage } from "../../stage-mail.ts";
import { attachedMaterialNodes, type ChainNode } from "./approved-chain.ts";

/** The lines the material opens and closes with; the transcript folds between them. */
export const MATERIAL_MAIL_LEAD = "The person attached this material after the stage opened:";
export const MATERIAL_MAIL_END = "--- END OF THE ATTACHED MATERIAL ---";
const MATERIAL_MAIL_ASK = "Read it before you answer, and take it into account from here on.";

/** What a mail carries for each file it hands over; a thread holding it has been sent that file. */
export function materialMarker(nodeId: string): string {
  return `[material:${nodeId}]`;
}

/**
 * The attached material this stage's specialist has not been sent, oldest
 * first. Nothing is owed on a thread with no mail yet: its opening is still
 * to go, and carries the material itself.
 */
export function owedMaterial(input: {
  readonly nodes: readonly ChainNode[];
  /** The stage thread as loaded, withdrawn turns included: a stopped turn was still sent. */
  readonly messages: readonly Pick<ChatMessage, "author" | "body" | "at">[];
}): ChainNode[] {
  const sentAt = input.messages.map((message) => Date.parse(message.at)).filter((at) => Number.isFinite(at));
  if (sentAt.length === 0) return [];
  const opened = Math.min(...sentAt);
  const mine = input.messages.filter((message) => message.author === "me");
  return attachedMaterialNodes(input.nodes).filter(
    (node) => Date.parse(node.createdAt) > opened && !mine.some((message) => message.body.includes(materialMarker(node.id))),
  );
}

/** The mail that hands the material over, each file under its name as the opening would carry it. */
export function composeMaterialMail(items: Inputs, stage: number): string {
  const markers = items.map((item) => materialMarker(item.node.id)).join(" ");
  return `${MATERIAL_MAIL_LEAD}\n\n${renderInputs(items, stage)}\n\n${MATERIAL_MAIL_END}\n\n${MATERIAL_MAIL_ASK} ${markers}`;
}

const MATERIAL_HEADING = /^--- MATERIAL THE PERSON PROVIDED: (.+) ---$/gm;

/**
 * A material mail taken apart for the transcript: the files it names and
 * the text it carries for them. Null for any other message. With a draft
 * on the table the mail travels as a revision turn, so the person's words
 * in one are looked at too; a mail that only quotes a material mail further down,
 * as a hand-off's recap does, is not one.
 */
export function splitMaterialMail(body: string): { readonly names: readonly string[]; readonly material: string } | null {
  const text = personWordsIn(body)?.words ?? body;
  if (!text.startsWith(MATERIAL_MAIL_LEAD)) return null;
  const end = text.indexOf(MATERIAL_MAIL_END);
  if (end === -1) return null;
  const material = text.slice(MATERIAL_MAIL_LEAD.length, end).trim();
  // A reading is titled after its file, "report.pdf (reading)"; the person attached "report.pdf".
  const names = [...material.matchAll(MATERIAL_HEADING)].map((match) => match[1]!.replace(/ \(reading\)$/, ""));
  return { names, material };
}

/** "a", "a and b", "a, b and c". */
export function namedTogether(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}
