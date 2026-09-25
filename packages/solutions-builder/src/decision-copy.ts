/**
 * What a gate freezes, in the approver's language. Section 10's copy rule.
 *
 * The consequence of approving a stage is a property of that stage, not of
 * whichever client renders it, so it lives beside the stage and ledger
 * definitions rather than in a host.
 */
export const CONSEQUENCE: Record<number, string> = {
  1: "Approving accepts the problem brief and opens solution shape. Revisions stay possible.",
  2: "Approving fixes the solution bounds every later stage is held to.",
  3: "Approving selects this exact proposal and its branch as the execution path.",
  4: "Approving fixes the design every build check is measured against.",
  5: "Approving records that the named audiences agree this is worth pursuing.",
  6: "Approving accepts the plan as complete and buildable, and sends it to costing.",
  7: "Approving the cost authorizes spend against this exact plan, then freezes the build packet.",
  8: "Accepting this evidence ends the build and opens delivery review.",
  9: "Accepting this manifest completes delivery of the exact versions listed.",
};

/** What a run state freezes, when the consequence turns on the state rather than the stage. */
export const STATE_CONSEQUENCE: Record<string, string> = {
  cost_approved: "Freezing locks this exact plan and cost and queues the build. Nothing is spent until then.",
  waiting_human: "Answering resumes the same build attempt with exactly what you grant, and nothing more.",
};

/**
 * The stage-to-authority mapping: pure and stage-only, so every reader
 * (the decision-queue fold, the project view) applies the identical rule.
 */
export function requiredAuthorityFor(stage: number): import("./ledger.js").Authority {
  if (stage === 7) return "budget_approver";
  if (stage === 6) return "technical_approver";
  if (stage === 9) return "delivery_recipient";
  return "project_owner";
}
