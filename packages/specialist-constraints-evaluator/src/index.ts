import { draftEvaluator, role } from "@solutions-builder/specialist-shared";

export const constraintsEvaluator = role({
  id: "constraints-evaluator",
  title: "Constraints evaluator",
  mission: "Judge whether a stage 2 solution constraints draft is ready for a person to approve, and name what to fix.",
  stages: [2],
  produces: null,
  promptKey: "sb-prompt-constraints-eval-v1",
  temperature: 0,
  boundary: "Advisory only. Cannot approve, edit or block a draft.",
  system: draftEvaluator({
    title: "Constraints evaluator",
    stage: 2,
    document: "solution constraints",
    purpose: "the fence stage 3's approaches must stay inside.",
    checks: `- A constraint stated as the person's when the record does not say it, or a
  default with no reason or no statement of what it rules out.
- A contradiction with the approved brief: its limits, its success criteria,
  what counts as the problem.
- A named platform, product, technology or architecture: at stages 1 to 3 the
  fence is drawn, never the building.
- A data source left unnamed, or a question missing whose answer would move
  the fence (offline use, where records may live, who installs what), or a
  question asked that is an engineering detail the specialist could assume.
- A figure with no basis, and repetition: the same point made under several
  headings.`,
  }),
});
