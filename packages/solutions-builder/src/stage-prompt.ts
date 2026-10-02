/**
 * The prose a stage specialist actually reads.
 *
 * Pure rendering: the approved inputs a stage opens with (`renderInputs`,
 * read by `apps/web`'s approved chain), a revision turn that carries the
 * current version (`revisionRequest`), and the stage 3 choice reminder and
 * repair. Nothing here touches a database, an inference call or
 * Interchange; the client composes the mail and this renders the pieces.
 */
import { MATERIAL_KIND } from "./artifacts.js";

export type Quote = { readonly quote: string };

export type StageTurn = {
  readonly id: string;
  readonly role: "human" | "specialist";
  readonly body: string;
  readonly quotes: Quote[];
  readonly resultNodeId: string | null;
  /** The questions a specialist turn opened a round with; null on every other turn. */
  readonly questions: string[] | null;
  readonly createdAt: string;
  /** Set on a specialist turn that reports a round the platform could not complete. */
  readonly failed?: true;
};

export type Inputs = { node: { id: string; title: string; kind: string; stage: number }; content: string }[];

/** The inputs as the specialist reads them. A document written this stage is not yet approved, and is labelled as such. */
export function renderInputs(inputs: Inputs, stage: number): string {
  if (inputs.length === 0) return "(No earlier approved artifacts. This is the first stage.)";
  return inputs
    .map((input) =>
      input.node.kind === MATERIAL_KIND
        ? `--- MATERIAL THE PERSON PROVIDED: ${input.node.title} ---\n${input.content}`
        : input.node.stage === stage
          ? `--- WRITTEN THIS STAGE, NOT YET APPROVED: ${input.node.title} (stage ${input.node.stage}, ${input.node.kind}) ---\n${input.content}`
          : `--- APPROVED INPUT: ${input.node.title} (stage ${input.node.stage}, ${input.node.kind}) ---\n${input.content}`,
    )
    .join("\n\n");
}

export const REVISION_LEAD = "--- THE CURRENT VERSION OF THIS DOCUMENT ---";
export const REVISION_ASK = "--- WHAT THE PERSON IS ASKING FOR NOW ---";

/**
 * A revision turn as alpha main sent one (#431): the current version of the
 * document, the instruction to revise it rather than start over, then the
 * person's own words. Without the current version in the turn the model
 * re-rolls the stage and version two is a different draft rather than a
 * better one, which is not what "revise" means to anyone. The chat shows
 * only the person's words; `splitRevision` is how it finds them.
 */
export function revisionRequest(args: { stage: number; userInput: string; currentDocument: string }): string {
  return [
    REVISION_LEAD,
    args.currentDocument.trim(),
    "",
    `Produce the next version of the stage ${args.stage} artifact. Revise the current version above rather than starting over: keep every part that was not objected to, apply what is asked for, and honour the standing directions. Use exactly the structure and format your instructions specify.`,
    "",
    REVISION_ASK,
    args.userInput.trim() || "(No further instruction. Improve the current version without changing what was agreed.)",
  ].join("\n");
}

export const DIRECTIONS_LEAD = "--- STANDING DIRECTIONS FROM THE PERSON (these still apply) ---";
/** Newest asks kept, in order. A warm turn does not resend these; a cold run does, once. */
export const DIRECTIONS_BUDGET = 4_000;
export const INTERVIEW_FOLD = "Fold this answer into the document. Keep the remaining questions. Do not add new ones.";

/** Earlier sentences the person sent, newest last, cut to `DIRECTIONS_BUDGET`. */
export function standingDirections(asks: readonly string[]): string {
  const kept: string[] = [];
  let used = 0;
  for (let index = asks.length - 1; index >= 0; index -= 1) {
    const ask = asks[index]?.trim() ?? "";
    if (ask.length === 0) continue;
    const line = `- ${ask}`;
    if (kept.length > 0 && used + line.length + 1 > DIRECTIONS_BUDGET) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

const APPLY_LEAD = "Apply only this:\n";

/** The person's own words out of a mail, revision envelope or not. */
export function personAsk(body: string): string {
  const revision = splitRevision(body);
  if (revision) return revision.ask.trim();
  // A revision mail stores the whole instruction. The sentence is what follows
  // "Apply only this:"; the fold line under it is the host's, not theirs.
  if (body.startsWith("Current version:")) {
    const at = body.lastIndexOf(APPLY_LEAD);
    if (at !== -1) {
      const ask = body.slice(at + APPLY_LEAD.length).trim();
      const foldAt = ask.endsWith(INTERVIEW_FOLD) ? ask.lastIndexOf(`\n\n${INTERVIEW_FOLD}`) : -1;
      return (foldAt === -1 ? ask : ask.slice(0, foldAt)).trim();
    }
  }
  return body.trim();
}

/**
 * The mail for a revision whose document is already an artifact.
 *
 * A warm turn names the id and the version. The bytes are already in the
 * session, so the mail does not carry them and does not re-list the person's
 * earlier sentences. A cold turn, the first mail of a run that does not have
 * that prefix, reads the artifact once and states those sentences once.
 */
export function revisionMail(args: {
  readonly artifactId: string;
  readonly version: number;
  readonly userInput: string;
  readonly cold: boolean;
  readonly directions: readonly string[];
  readonly interviewing: boolean;
}): string {
  const ask = args.userInput.trim();
  const apply = [ask, args.interviewing ? INTERVIEW_FOLD : ""].filter((part) => part.length > 0).join("\n\n");
  const versionLine = `Current version: ${args.artifactId} v${args.version}.`;
  if (!args.cold) {
    return [
      versionLine,
      "Revise it with artifact_write on that same id. It is already in this conversation. Do not call artifact_read.",
      "",
      "Apply only this:",
      apply,
    ].join("\n");
  }
  const directions = standingDirections(args.directions);
  return [
    versionLine,
    "Call artifact_read on it once, then artifact_write the revision on that same id.",
    "",
    ...(directions.length > 0 ? [DIRECTIONS_LEAD, directions, ""] : []),
    "Apply only this:",
    apply,
  ].join("\n");
}

/** A revision turn taken apart: the document it carried, and the person's ask. Null for any other message. */
export function splitRevision(text: string): { readonly document: string; readonly ask: string } | null {
  if (!text.startsWith(REVISION_LEAD)) return null;
  const at = text.indexOf(REVISION_ASK);
  if (at === -1) return null;
  const inner = text.slice(REVISION_LEAD.length, at).trim();
  const cut = inner.lastIndexOf("\n\nProduce the next version");
  return { document: (cut === -1 ? inner : inner.slice(0, cut)).trim(), ask: text.slice(at + REVISION_ASK.length).trim() };
}

/**
 * A stage-3 choice the revised document must record, not relitigate. The
 * workspace shows the choice buttons instead of approval until a
 * `## Chosen approach` section exists, so a draft that absorbs the choice
 * anywhere else leaves the person choosing again. Anything that is not a
 * stage-3 choice passes through untouched.
 *
 * The reminder below is only a prompt: when the model ignores it,
 * `ensureChoiceSection` writes the section deterministically after the
 * draft lands, so approval is never stuck behind a missed instruction.
 */
/** A stage-3 choice the person's message made, taken apart for the prompt and the repair alike. */
function choiceIn(stage: number, userInput: string): { heading: string; letter: string; name: string | null } | null {
  if (stage !== 3 || !/^chosen:/i.test(userInput.trim())) return null;
  const match = /^chosen:\s*approach\s+([ab])\s*\(([^)]+)\)/i.exec(userInput.trim());
  if (!match) return { heading: "Chosen approach", letter: "", name: null };
  return { heading: `Chosen approach: ${match[2]!.trim()}`, letter: match[1]!.toUpperCase(), name: match[2]!.trim() };
}

export function withChoiceReminder(stage: number, userInput: string): string {
  const choice = choiceIn(stage, userInput);
  if (!choice) return userInput;
  const heading = `## ${choice.heading}`;
  return `${userInput.trim()}\n\nThe choice is made: open the revised document with a "${heading}" section naming the chosen approach and why it won, keep the other approach under its own heading as the rejected alternative, and keep Side by side. Do not ask the choice question again.`;
}

/**
 * The deterministic fallback for a model that ignored the reminder above: a
 * stage-3 draft written after the person chose, but with no
 * `## Chosen approach` section, gains one naming the choice. The section
 * records the decision — the comparison under Side by side still carries the
 * trade-offs — so the workspace offers approval instead of asking again. A
 * compliant draft, and anything that is not a stage-3 choice, passes through
 * untouched.
 */
export function ensureChoiceSection(stage: number, userInput: string, draft: string): string {
  const choice = choiceIn(stage, userInput);
  if (!choice) return draft;
  if (/^##\s+chosen approach\b/im.test(draft)) return draft;
  const named = choice.name !== null ? `Approach ${choice.letter} (${choice.name})` : "the chosen approach";
  const section = [
    `## ${choice.heading}`,
    "",
    `The person chose ${named}. Why it won, and the rejected alternative, are read from the approaches below — this section records the choice so the document opens with what was decided.`,
  ].join("\n");
  const lines = draft.replace(/\r\n/g, "\n").split("\n");
  const inShort = lines.findIndex((line) => /^##\s+in short\b/i.test(line.trim()));
  if (inShort !== -1) {
    let end = lines.length;
    for (let at = inShort + 1; at < lines.length; at += 1) {
      if (/^##\s+/.test(lines[at]!)) {
        end = at;
        break;
      }
    }
    return [...lines.slice(0, end), "", section, "", ...lines.slice(end)].join("\n").trim().concat("\n");
  }
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  if (firstSection !== -1) return [...lines.slice(0, firstSection), section, "", ...lines.slice(firstSection)].join("\n").trim().concat("\n");
  return `${section}\n\n${draft}`;
}
