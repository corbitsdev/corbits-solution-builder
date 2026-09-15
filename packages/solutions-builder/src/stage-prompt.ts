/**
 * The prose a stage specialist actually reads.
 *
 * Pure rendering: turning approved inputs, the current document, the
 * conversation so far and the person's own words into the one prompt string
 * a drafting round hands to its agent step. Nothing here touches the
 * database, an inference call, or Interchange — the host builds the pieces
 * (`apps/hub`'s `stage-runs.ts` and `agent-conversation.ts`) and this module
 * only renders them.
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

export type StageContext = { brief: string | null; recent: StageTurn[] };

/** Renders one turn for the compactor's prompt, and for the draft prompt. */
export function renderTurns(turns: StageTurn[]): string {
  return turns
    .map((turn) => {
      if (turn.role === "specialist") return `SPECIALIST: ${turn.body}`;
      const quoted = turn.quotes
        .map((entry) => `  (about this passage: "${entry.quote}")`)
        .join("\n");
      return `PERSON: ${turn.body}${quoted ? `\n${quoted}` : ""}`;
    })
    .join("\n\n");
}

/** The conversation section of a draft prompt. Empty when there is none. */
export function renderStageContext(context: StageContext): string {
  const sections: string[] = [];
  if (context.brief) {
    sections.push(
      "--- STANDING DIRECTIONS FROM THE PERSON (these still apply) ---",
      context.brief,
    );
  }
  if (context.recent.length > 0) {
    sections.push("--- THE CONVERSATION SO FAR ---", renderTurns(context.recent));
  }
  return sections.join("\n\n");
}

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
 * The draft prompt.
 *
 * Pure, and exported, so the two properties that matter can be checked without
 * a provider: that a revision carries the document it is revising, and that
 * the standing directions travel with it.
 *
 * Without the current version in the prompt the model re-rolls the stage from
 * scratch and version two is a different draft rather than a better one, which
 * is not what "revise" means to anyone.
 */
export function buildDraftPrompt(args: {
  projectTitle: string;
  stage: number;
  inputs: string;
  userInput: string;
  currentDocument?: string;
  context?: StageContext;
}): string {
  const revising = (args.currentDocument ?? "").trim().length > 0;
  const conversation = args.context ? renderStageContext(args.context) : "";

  return [
    `Project: ${args.projectTitle}`,
    "",
    args.inputs,
    ...(revising
      ? ["", "--- THE CURRENT VERSION OF THIS DOCUMENT ---", args.currentDocument!.trim()]
      : []),
    ...(conversation ? ["", conversation] : []),
    "",
    "--- WHAT THE PERSON IS ASKING FOR NOW ---",
    args.userInput.trim() ||
      (revising
        ? "(No further instruction. Improve the current version without changing what was agreed.)"
        : "(The user gave no further input; work from the approved inputs above.)"),
    "",
    revising
      ? `Produce the next version of the stage ${args.stage} artifact. Revise the current version above rather than starting over: keep every part that was not objected to, apply what is asked for, and honour the standing directions. Use exactly the headings your instructions specify.`
      : `Produce the stage ${args.stage} artifact now, using exactly the headings your instructions specify.`,
  ].join("\n");
}
