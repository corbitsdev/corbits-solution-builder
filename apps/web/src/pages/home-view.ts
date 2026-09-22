/**
 * Home list view: mockup labels and the 9-seg track, kept pure so the page
 * and the tests share one source.
 */

export const HOME_COMPOSER_PLACEHOLDER = "Describe the thing you want built…";
export const HOME_EMPTY_TITLE = "Nothing yet";
export const HOME_EMPTY_DESCRIPTION = "Describe the thing above — the discovery stage starts there.";
export const HOME_NEEDS_DECISION = "Needs decision";

/**
 * Card-foot labels only. Workspace/topbar keep `STAGE_NAMES` in components.tsx;
 * these match mockups/index.html Title Case and must not leak there.
 */
export const HOME_CARD_STAGE_NAMES = [
  "Problem Discovery",
  "Solution Shape",
  "Proposal",
  "GUI Design",
  "Concept Approval",
  "Build Plan",
  "Cost Approval",
  "Build & Test",
  "Deliver",
] as const;

/** Ten characters is the create gate; the mockup has no hint line. */
export function canStartProject(problem: string): boolean {
  return problem.trim().length >= 10;
}

/**
 * One-liner under the card title. The list payload has no problem statement;
 * use it when a caller has one, otherwise the title already on the card.
 * Never invent a subtitle.
 */
export function cardDescription(project: { title: string; problemStatement?: string | null }): string {
  const problem = project.problemStatement?.trim();
  if (problem) {
    const line = problem.split("\n")[0]?.trim();
    if (line) return line;
  }
  return project.title;
}

/**
 * One segment of the mockup's 9-seg track: prior stages fill, the live one
 * stretches (`now`), and a finished project fills the current segment too.
 */
export function stageTrackSegClass(at: number, stage: number | null, done: boolean): string {
  if (stage === null) return "seg";
  if (at < stage || (done && at <= stage)) return "seg done";
  if (at === stage) return "seg now";
  return "seg";
}

/** Left side of `.card-foot`: the stage's name, never a fake relative time. */
export function cardFootStage(stage: number | null, done: boolean, failed: boolean): string {
  if (failed) return "Status unavailable";
  if (done) return "Delivered";
  if (stage === null) return "Not started";
  return HOME_CARD_STAGE_NAMES[stage - 1] ?? `Stage ${stage}`;
}
