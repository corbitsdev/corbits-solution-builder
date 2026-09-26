/**
 * What to tell the person when their project's workflow was moved onto new
 * code and the new rules refused a decision the old code had accepted
 * (#51). The refusal itself is the reducer's ledger row -- the workflow
 * recorded it, this only reads it out -- so the notice names each refused
 * decision with the workflow's own wording for its reason, and says what
 * that means: the project is where the new rules put it, and the decision
 * has to be taken again if it is still wanted.
 */
import { approveReasonText, type ApproveReason } from "@solutions-builder/app/project-workflow/contracts";
import type { ProjectWorkflowReplay } from "@solutions-builder/installer";
import { stageName } from "../../components.jsx";

const DECISION_NAMES: Readonly<Record<string, string>> = {
  open_review: "review opening",
  approve: "approval",
  send_back: "send-back",
  audience: "stakeholder decision",
  mint_requirements: "requirement ids",
};

function decisionName(kind: string | null): string {
  return (kind ? DECISION_NAMES[kind] : undefined) ?? "decision";
}

/** Null when nothing was refused: a replay that changed nothing needs no notice. */
export function describeReplay(replay: ProjectWorkflowReplay | undefined): { title: string; detail: string } | null {
  if (!replay || replay.refused.length === 0) return null;
  const items = replay.refused.map((refusal) => {
    const where = refusal.stage === null ? "" : ` at ${stageName(refusal.stage)}`;
    const reason = approveReasonText(refusal.reason as ApproveReason, null);
    return `The ${decisionName(refusal.kind)}${where} was refused: ${reason.endsWith(".") ? reason : `${reason}.`}`;
  });
  const count = replay.refused.length;
  return {
    title:
      count === 1
        ? "This project's workflow was updated, and one earlier decision no longer holds under the new rules."
        : `This project's workflow was updated, and ${String(count)} earlier decisions no longer hold under the new rules.`,
    detail: `The project stands where the updated rules put it. ${items.join(" ")} Take any of these again if it is still wanted.`,
  };
}
