import { draftEvaluator, role } from "@solutions-builder/specialist-shared";

export const approachEvaluator = role({
  id: "approach-evaluator",
  title: "Approach evaluator",
  mission: "Judge whether a stage 3 proposal draft is ready for a person to approve, and name what to fix.",
  stages: [3],
  produces: null,
  promptKey: "sb-prompt-approach-eval-v1",
  temperature: 0,
  boundary: "Advisory only. Cannot approve, edit or block a draft.",
  system: draftEvaluator({
    title: "Approach evaluator",
    stage: 3,
    document: "proposal",
    purpose: "choosing between at most two approaches that both stay inside the approved constraints.",
    checks: `- An approach that breaks an approved constraint without saying which one
  and what relaxing it would cost.
- Two approaches that are not genuinely different, or a "Side by side" table
  whose cells do not separate them on the criteria a choice turns on.
- A success criterion from the brief that neither approach is shown to reach,
  with no relaxation proposed.
- Effort or time priced as human work (engineer-days, sprints) rather than
  the coding agent's rounds and the gates; a cost or figure with no basis.
- A recommendation that does not say what would change the specialist's mind,
  or a named platform or technology (too early at stage 3).`,
  }),
});
