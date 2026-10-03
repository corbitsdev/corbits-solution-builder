/** What each stage is called on screen. Stages are named, never numbered, wherever a person reads them. */
const STAGE_NAMES = [
  "Problem discovery",
  "Solution shape",
  "Solution proposal",
  "GUI design",
  "Concept approval",
  "Build plan",
  "Cost approval",
  "Build and test",
  "Deliver",
];

export function stageName(stage: number | null): string {
  return stage === null ? "Not started" : (STAGE_NAMES[stage - 1] ?? `Stage ${stage}`);
}
