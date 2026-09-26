/**
 * What a stage's specialist is doing while their turn runs, for the busy
 * strip's caption (#113): which specialist, and the stage's own task in a
 * few words. Named by the kit's role for the stage, so a renamed specialist
 * is renamed here too.
 */
import { agentFor } from "@solutions-builder/app/kit";
import type { Stage } from "@solutions-builder/app/ledger";

const STAGE_ACTIVITY: Record<number, string> = {
  1: "interviewing the problem and drafting the brief",
  2: "mapping the constraints",
  3: "comparing two approaches",
  4: "drawing the design",
  5: "writing the stakeholder packages and their slides",
  6: "writing the build plan",
  7: "preparing the estimate",
  8: "building the software",
  9: "verifying the delivery",
};

/** "Presentation creator is writing the stakeholder packages and their slides". */
export function specialistActivity(stage: number): string {
  const inRange = stage >= 1 && stage <= 9;
  const who = inRange ? agentFor(stage as Stage).title : "The specialist";
  const doing = STAGE_ACTIVITY[stage] ?? "working on this stage";
  return `${who} is ${doing}`;
}
