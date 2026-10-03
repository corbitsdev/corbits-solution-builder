import { draftEvaluator, role } from "@solutions-builder/specialist-shared";

export const estimateEvaluator = role({
  id: "estimate-evaluator",
  title: "Estimate evaluator",
  mission: "Judge whether a stage 7 cost approval draft is ready for a person to approve, and name what to fix.",
  stages: [7],
  produces: null,
  promptKey: "sb-prompt-estimate-eval-v1",
  temperature: 0,
  boundary: "Advisory only. Cannot approve, edit or block a draft.",
  system: draftEvaluator({
    title: "Estimate evaluator",
    stage: 7,
    document: "cost approval",
    purpose: "the figure a budget approver signs against.",
    checks: `- A rate, price or allowance the record does not give, written as a figure
  instead of a quantity times a named unknown.
- Arithmetic that does not add up, or a total that does not match its lines.
- A forecast that prices a different stack or scope than the plan's
  "## Stack" block and tasks, or leaves out a task the plan has.
- Time given as human effort rather than the coding agent's wall-clock plus
  the gates; an unknown quota treated as zero cost or unlimited.
- A tolerance that a person could not apply: no threshold, or no action when
  it is crossed; and repetition of the same caveat across sections.`,
  }),
});
