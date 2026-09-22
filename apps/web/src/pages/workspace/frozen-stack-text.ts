/**
 * Stage 8's opening mail carries the frozen stack decision as plain text --
 * never a package list -- so the build specialist gets it without re-reading
 * the whole plan for the `## Stack` block.
 *
 * CL-8862 lane A is landing `Freeze.stack`, set the moment stage 7 is
 * approved and the process authority on what was actually frozen. Until that
 * merges, this parses the stack back out of the frozen plan text itself.
 *
 * Swap point: once `Freeze.stack` exists, replace the body of this function
 * with `const stack = freeze.stack;` and drop the `parseStackRecord` fallback
 * and the `planText` parameter entirely.
 */
import { describeOperation, parseStackRecord, type StackRecord } from "@solutions-builder/app/stack";

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

export function renderStackBlock(freeze: unknown, planText: string): string | null {
  const stack = (freeze as { readonly stack?: StackRecord } | null | undefined)?.stack ?? parseStackRecord(planText);
  return stack ? renderStackText(stack) : null;
}
