import type { ActionHandler } from "@intx/workflow";
import {
  applyDecision as applyDecisionReducer,
  initProjectState,
  type ApplyDecisionInput,
  type InitProjectPayload,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the loop's initial carry from the manual trigger payload.
 *
 * Every top-level run is fired through the mail-shaped trigger route
 * (vendor/interchange/packages/hub-api/src/workflow-run-trigger.ts), so a
 * REAL deployed run's `trigger.payload` is a decoded `Mail` object, not the
 * raw init payload -- the JSON lives in the resolved mail part's inline
 * `text`. `runLocal` (the in-process harness) hands `trigger.payload`
 * straight through with no mail wrapping, so both shapes are handled here
 * rather than duplicated per deploy target.
 */
export const initProject: ActionHandler = async (input) => {
  const part = isRecord(input) && Array.isArray(input["parts"])
    ? (input["parts"] as unknown[]).find((p): p is { text: string } => isRecord(p) && typeof p["text"] === "string")
    : undefined;
  const payload = part ? (JSON.parse(part.text) as InitProjectPayload) : (input as InitProjectPayload);
  return initProjectState(payload);
};

/** Pure reducer, no injected dependency: the workflow never reads an
 *  artifact's content, only the reference a decision names. Exported as
 *  `applyDecision`, matching the `handler: "applyDecision"` ref in
 *  workflow.ts -- the sidecar resolves an action handler by that exact name
 *  off this module. */
export const applyDecision: ActionHandler = async (input) => applyDecisionReducer(input as ApplyDecisionInput);

/** Identity: parks the loop's carried state in a step output (see workflow.ts). */
export const holdState: ActionHandler = async (input) => input;

/** Exhaustion is recorded, never treated as approval. */
export const recordExhausted: ActionHandler = async (input) => ({
  exhausted: true,
  carry: input,
});
