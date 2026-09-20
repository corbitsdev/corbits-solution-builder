import type { LoopFn } from "@intx/workflow";
import type { ProjectState } from "./contracts.js";

/**
 * The ONE source for the loop's `while`/`carry`, imported both by the
 * in-process workflow definition (`workflow.ts`) and bundled standalone into
 * the deployed package's `interchange.loops` module (see
 * `scripts/project-workflow-pack.ts`) -- no hand-duplicated mirror.
 */
function applyOutputOf(childOutput: unknown): ProjectState {
  const out = (childOutput as Record<string, unknown> | null)?.["apply"];
  if (!out || typeof out !== "object") throw new Error("project workflow loop body missing apply output");
  return out as ProjectState;
}

export const projectWorkflowLoopWhile: LoopFn = (childOutput) => !applyOutputOf(childOutput).done;
export const projectWorkflowLoopCarry: LoopFn = (childOutput) => applyOutputOf(childOutput);
