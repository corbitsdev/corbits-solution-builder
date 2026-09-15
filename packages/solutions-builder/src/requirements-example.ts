/**
 * What counts as a "worked example" heading in a requirements document —
 * the one place that knows it. The stage-6 requirements author is told to
 * head that section with one of these words; the completion judge's
 * `extractExampleInput` (`apps/hub/src/completion-judge.ts`) looks for the
 * same words to find the input it later feeds the built deliverable. Both
 * reads must agree on what counts as an example heading, so the words live
 * here rather than being retyped at either call site.
 */

/** Words that name a worked-example heading, case-insensitively. */
export const EXAMPLE_HEADING_WORDS = ["example", "sample", "walkthrough", "scenario"] as const;

export const EXAMPLE_HEADING_PATTERN = new RegExp(EXAMPLE_HEADING_WORDS.join("|"), "i");
