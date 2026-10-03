import { draftEvaluator, role } from "@solutions-builder/specialist-shared";

export const planEvaluator = role({
  id: "plan-evaluator",
  title: "Plan evaluator",
  mission: "Judge whether a stage 6 build plan draft is ready for a person to approve, and name what to fix.",
  stages: [6],
  produces: null,
  promptKey: "sb-prompt-plan-eval-v1",
  temperature: 0,
  boundary: "Advisory only. Cannot approve, edit or block a draft.",
  system: draftEvaluator({
    title: "Plan evaluator",
    stage: 6,
    document: "build plan",
    purpose: "the plan a coding agent executes without re-litigating stages 1 to 4.",
    checks: `- A requirement id from the authoritative block that the Acceptance criteria
  table traces to no task, interface or test, and that is not named under
  risks; an id cited that is not in the block, or an id outside that table
  and the stack block's cites.
- An owner summary the non-technical owner cannot follow, or that leaves
  out what is built, how it runs, its running cost or its risks; a Source
  versions line that narrates what was or was not supplied.
- A section that contradicts another or an approved document.
- A task whose completion is not observable, or the seed script that loads
  real data missing as its own task.
- A "## Stack" section without exactly one well-formed \`\`\`json stack block,
  or an entry whose cites are empty; a mode stepped up that no requirement
  forces.
- A contradiction with an approved constraint (data stored where it may not
  be, a component the constraints exclude), or a primitive rebuilt that the
  platform already provides.
- An acceptance criterion or test that does not map to a requirement's
  acceptance criterion, or time sized as human effort.`,
  }),
});
