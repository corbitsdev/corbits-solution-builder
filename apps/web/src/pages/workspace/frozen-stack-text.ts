/**
 * Stage 8's opening mail carries the frozen stack decision as plain text --
 * never a package list -- so the build specialist gets it without re-reading
 * the whole plan for the `## Stack` block.
 *
 * `Freeze.stack` (`project-workflow/contracts.ts`, CL-8862) is the process
 * authority on what was actually frozen at stage 7 -- read straight off it,
 * never re-derived from the plan's text.
 */
import { describeOperation, type StackRecord } from "@solutions-builder/app/stack";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";

function renderStackText(stack: StackRecord): string {
  const description = describeOperation(stack);
  return [
    "## How it will run",
    `- Starting it: ${description.start}`,
    `- Where it runs: ${description.where}`,
    `- Who it's for: ${description.who}`,
    `- What it needs: ${description.needs}`,
    `- Ongoing cost: ${description.cost}`,
    `- Shared, or cloud: ${description.shareOrCloud}`,
  ].join("\n");
}

export function renderStackBlock(freeze: Pick<Freeze, "stack"> | null | undefined): string | null {
  return freeze ? renderStackText(freeze.stack) : null;
}
