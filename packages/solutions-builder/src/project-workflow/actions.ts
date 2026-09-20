import type { ActionHandler } from "@intx/workflow";
import {
  applyDecision,
  initProjectState,
  type ApplyDecisionInput,
  type InitProjectPayload,
  type ReadArtifact,
} from "./contracts.js";

/** Builds the loop's initial carry from the manual trigger payload. */
export const initProject: ActionHandler = async (input) => {
  return initProjectState(input as InitProjectPayload);
};

/**
 * `readArtifact` is the reducer's only injected dependency; it is bound here
 * via closure so the handler stays a bare function the action resolver can
 * hand to the runtime, matching how `handler` refs are resolved.
 */
export function createApplyDecisionAction(readArtifact: ReadArtifact): ActionHandler {
  return async (input) => applyDecision(input as ApplyDecisionInput, readArtifact);
}

/** Identity: parks the loop's carried state in a step output (see workflow.ts). */
export const holdState: ActionHandler = async (input) => input;

/** Exhaustion is recorded, never treated as approval. */
export const recordExhausted: ActionHandler = async (input) => ({
  exhausted: true,
  carry: input,
});
