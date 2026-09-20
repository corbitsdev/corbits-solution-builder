/**
 * Where a send-back goes. The ledger lets a stage waiting for approval be
 * routed to any stage up to itself, so the person names the stage rather
 * than being sent one step back: someone at Concept approval who missed
 * part of the problem returns to the brief. Shared by the Decision Queue
 * and the stage workspace so both say the same thing.
 */
import { stageName } from "../components.jsx";

/**
 * What going back to each stage is for, in the person's terms: the reason
 * they would name it as the target rather than the stage before this one.
 */
export const RETURN_TO: Record<number, string> = {
  1: "revise the problem brief",
  2: "change the solution bounds",
  3: "choose or rework the approach",
  4: "revise the design",
  5: "redo the packages",
  6: "correct the plan",
  7: "re-estimate the cost",
  8: "build again",
  9: "redo the delivery",
};

/** The stage a send-back returns to unless the person names another: the one before this. */
export function defaultTarget(stage: number): number {
  return Math.max(1, stage - 1);
}

export function SendBackPicker({
  id,
  stage,
  target,
  onChange,
}: {
  id: string;
  /** The stage being sent back; the picker offers every stage up to it. */
  stage: number;
  target: number;
  onChange: (target: number) => void;
}) {
  const stages = Array.from({ length: stage }, (_, index) => index + 1);
  return (
    <div className="field">
      <label htmlFor={id}>Send back to</label>
      <select id={id} className="setting-select decision-target" value={target} onChange={(event) => onChange(Number(event.target.value))}>
        {stages.map((candidate) => (
          <option key={candidate} value={candidate}>
            Stage {candidate} — {stageName(candidate)}
            {candidate === stage ? " (this stage again)" : RETURN_TO[candidate] ? `, to ${RETURN_TO[candidate]}` : ""}
          </option>
        ))}
      </select>
      <p className="inline-note">
        {target === stage
          ? "The work is redone at this stage. What was decided is kept as history."
          : `Stages ${target} to ${stage} are walked again from there. Each specialist revises its current document against the change rather than starting over.`}
      </p>
    </div>
  );
}
