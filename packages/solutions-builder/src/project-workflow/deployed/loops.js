// Shipped via `interchange.loops`, resolved by the string refs workflow.js's
// `loop({ while, carry })` names. See
// packages/solutions-builder/src/project-workflow/workflow.ts for the
// in-process twin these mirror.

function applyOutputOf(childOutput) {
  const out = childOutput && childOutput.apply;
  if (!out || typeof out !== "object") throw new Error("project workflow loop body missing apply output");
  return out;
}

export function projectWorkflowLoopWhile(childOutput) {
  return !applyOutputOf(childOutput).done;
}

export function projectWorkflowLoopCarry(childOutput) {
  return applyOutputOf(childOutput);
}
