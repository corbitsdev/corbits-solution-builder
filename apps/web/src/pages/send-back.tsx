/**
 * Where a send-back goes. The ledger lets a stage waiting for approval be
 * routed to any stage up to itself, so the person names the stage rather
 * than being sent one step back: someone at Concept approval who missed
 * part of the problem returns to the brief. Shared by the Decision Queue
 * and the stage workspace so both say the same thing.
 */
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
