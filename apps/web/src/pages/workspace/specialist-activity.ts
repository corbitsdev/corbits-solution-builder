/**
 * What a stage's specialist is doing while their turn runs, for the busy
 * strip's caption (#113): which specialist, and the stage's own task in a
 * few words. Named by the kit's role for the stage, so a renamed specialist
 * is renamed here too.
 */
import { agentFor } from "@solutions-builder/app/kit";
import type { Stage } from "@solutions-builder/app/ledger";
import type { AskKind } from "./message-intent.ts";

const STAGE_ACTIVITY: Record<number, string> = {
  1: "interviewing the problem and drafting the brief",
  2: "mapping the constraints",
  3: "comparing two approaches",
  4: "drawing the design",
  5: "writing the stakeholder packages and their slides",
  6: "writing the build plan",
  7: "preparing the estimate",
  8: "reviewing the build",
  9: "verifying the delivery",
};

/** The document each stage's specialist redrafts, for the busy line. */
const STAGE_DOCUMENT: Record<number, string> = {
  1: "the brief",
  2: "the constraints",
  3: "the approach",
  4: "the design",
  5: "the stakeholder packages",
  6: "the build plan",
  7: "the estimate",
  8: "the build",
  9: "the delivery",
};

/** "Presentation creator is writing the stakeholder packages and their slides". */
export function specialistActivity(stage: number, ask: AskKind = "draft"): string {
  const inRange = stage >= 1 && stage <= 9;
  const who = inRange ? agentFor(stage as Stage).title : "The specialist";
  // The label follows what was asked (#407), not only the stage: a
  // question is answered, an existing draft is redrafted, a first draft is
  // the stage's own task.
  if (ask === "review") return `${who} is improving the draft with the reviewer's notes`;
  if (ask === "question") return `${who} is answering`;
  if (ask === "redraft") return `${who} is redrafting ${STAGE_DOCUMENT[stage] ?? "the draft"}`;
  const doing = STAGE_ACTIVITY[stage] ?? "working on this stage";
  return `${who} is ${doing}`;
}
