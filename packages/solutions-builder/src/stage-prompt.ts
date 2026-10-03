/**
 * The prose a stage specialist actually reads.
 *
 * Pure rendering: the approved inputs a stage opens with (`renderInputs`,
 * read by `apps/web`'s approved chain), and the stage 3 choice repair.
 * Nothing here touches a database, an inference call or Interchange.
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
  readonly subject?: string;
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

/**
 * What a stage's draft evaluator is mailed: the record the stage opened
 * with, then the draft. Without the record it could judge only the page,
 * never whether the page is faithful to what was approved.
 */
export function evaluationRequest(args: { record: string | null; draft: string }): string {
  if (!args.record) return args.draft;
  return ["--- THE RECORD THE DRAFT WAS WRITTEN FROM ---", args.record.trim(), "", "--- THE DRAFT TO JUDGE ---", args.draft.trim()].join("\n");
}

/** The evaluator's notes, as the one revision the app asks the specialist for before the person reviews. */
export function evaluatorNotesAsk(notes: readonly string[]): string {
  return [
    "A reviewer read this version against the record and noted the points below. Fix each one that holds up against the record; where one does not, leave that part as it is. Change nothing else. Reply in one or two sentences saying what changed in the document, and ask nothing: the person has not yet answered your last question.",
    "",
    ...notes.map((note) => `- ${note}`),
  ].join("\n");
}

/**
 * The deterministic fallback for a proposer that ignored its instruction to
 * record the choice (#430): the workspace offers the choice buttons instead
 * of approval until a `## Chosen approach` section exists. A stage-3 draft
 * written after the person chose, but with no such section, gains one
 * naming the choice. The section
 * records the decision — the comparison under Side by side still carries the
 * trade-offs — so the workspace offers approval instead of asking again. A
 * compliant draft passes through untouched.
 */
export function ensureChoiceSection(choice: string, draft: string): string {
  if (/^##\s+chosen approach\b/im.test(draft)) return draft;
  const section = [
    `## Chosen approach: ${choice}`,
    "",
    `The person chose ${choice}. Why it won, and the rejected alternative, are read from the approaches below — this section records the choice so the document opens with what was decided.`,
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
