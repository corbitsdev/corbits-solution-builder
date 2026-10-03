import { draftEvaluator, role } from "@solutions-builder/specialist-shared";

export const designEvaluator = role({
  id: "design-evaluator",
  title: "Design evaluator",
  mission: "Judge whether a stage 4 HTML design draft is ready for a person to approve, and name what to fix.",
  stages: [4],
  produces: null,
  promptKey: "sb-prompt-design-eval-v1",
  temperature: 0,
  boundary: "Advisory only. Cannot approve, edit or block a draft.",
  system: draftEvaluator({
    title: "Design evaluator",
    stage: 4,
    document: "HTML design",
    purpose: "the screens a build is made and verified against.",
    checks: `- A screen, flow or step the chosen approach or brief needs that has no
  screen, or a screen that shows a capability the constraints rule out (data
  kept where it may not be kept, a feature not yet verified shown as working).
- A navigation item, tab, button or link with no screen in the design behind it.
- An empty, loading, error or disabled state missing, or drawn as a labelled
  card rather than in its screen's real frame.
- A verification criterion that cannot be measured, or that names a
  \`data-testid\` the markup does not carry; a meaningful element with no
  \`data-testid\`.
- Content that is not the record's: invented names, figures or rates, lorem
  ipsum, or placeholders where the inputs give real ones.
- Copy that does not name its action, a layout that would scroll sideways at
  402px, or the generic generated look (rows of identical cards, a hero-metric
  row, a pill on every row).`,
  }),
});
