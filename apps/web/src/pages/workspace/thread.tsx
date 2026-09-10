import { useEffect, useState } from "react";
import { Markdown } from "../../markdown.jsx";
import { choicesIn } from "./choices.js";

/**
 * What the specialist is doing while it writes, in its own stage's terms. One
 * word for every stage read as a spinner; these say what the wait is for.
 */
export const STAGE_VERBS: Record<number, string[]> = {
  1: ["Listening", "Sharpening the problem", "Finding the real pain", "Writing the brief"],
  2: ["Drawing the boundaries", "Weighing constraints", "Naming the non-goals", "Writing"],
  3: ["Weighing trade-offs", "Comparing approaches", "Testing each against your criteria", "Writing"],
  4: ["Sketching", "Walking the flows", "Working out the states", "Writing"],
  5: ["Writing for each audience", "Making the case", "Writing"],
  6: ["Sequencing the work", "Sizing the steps", "Checking dependencies", "Writing"],
  7: ["Counting", "Costing the plan", "Checking the numbers", "Writing"],
};

/** The shimmering "working" word, rotating through the stage's verbs. */
export function WorkingLabel({ stage }: { stage: number }) {
  const verbs = STAGE_VERBS[stage] ?? ["Writing"];
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (verbs.length < 2) return;
    const timer = setInterval(() => setAt((current) => (current + 1) % verbs.length), 3_200);
    return () => clearInterval(timer);
  }, [verbs.length]);
  return (
    <span className="thinking" key={at}>
      {verbs[at]}
    </span>
  );
}

/**
 * A specialist's turn ends in the question it is asking. Set apart from what
 * came before it, so a reader can tell what they are being asked from what
 * they are being told.
 */
export type TurnNote = {
  /** A person spoke just before this turn. */
  answered: boolean;
  version: number | null;
  nodeId: string | null;
  /** Opens a new round of questions after re-reading everything. */
  fresh: boolean;
  /** What the document is called, lower case: "problem brief", "constraints". */
  noun: string;
};

export function SpecialistTurn({
  text,
  note,
  onOpenVersion,
  onAnswer,
}: {
  text: string;
  note: TurnNote | null;
  onOpenVersion: (nodeId: string) => void;
  /** Set while the turn can be answered; a tapped option is sent as the answer. */
  onAnswer?: ((answer: string) => void) | undefined;
}) {
  // A turn that offers choices ends in the question and its options. One that
  // only asks ends in the question. Either way the question is set apart.
  const choices = choicesIn(text);
  const cut = text.lastIndexOf("\n\n");
  const last = (cut >= 0 ? text.slice(cut + 2) : text).trim();
  const question = choices?.question ?? (last.endsWith("?") ? last : null);
  const before = choices ? choices.before : question ? text.slice(0, Math.max(cut, 0)) : text;
  const options = choices?.options ?? [];
  return (
    <>
      {note ? (
        <p className="turn-note">
          {note.answered ? <span>Noted</span> : null}
          {note.version !== null && note.nodeId ? (
            <button type="button" className="turn-version" onClick={() => onOpenVersion(note.nodeId!)}>
              {note.noun} updated to v{note.version}
            </button>
          ) : null}
          {question ? <span>{note.fresh ? "new round of questions" : "next question"}</span> : null}
        </p>
      ) : null}
      {before.trim() ? <Markdown source={before} /> : null}
      {question ? <p className="turn-question">{question}</p> : null}
      {question && options.length > 0 ? (
        <div className="turn-options" role="group" aria-label="Likely answers">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="turn-option"
              disabled={!onAnswer}
              onClick={() => onAnswer?.(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
