/**
 * What a packed specialist reads at deploy time rather than at pack time: the
 * model pin and the workspace's language and design guidance. The installer
 * writes each as a module beside `workflow.js`, and `scripts/specialist-pack.ts`
 * leaves both imports external, so the stubs beside this file are never what
 * a deployed specialist runs.
 */
import SOURCE from "./inference-source.js";
import GUIDANCE from "./workspace-guidance.js";
import { skillTextFor } from "./skill-text.ts";

/** The model pin the agent's inference source names. */
export const INFERENCE_SOURCE = SOURCE;

/**
 * A role's system prompt in the order main deployed it: the role's own text,
 * the workspace's guidance when there is any, then the skills it carries.
 */
export function composeSpecialistPrompt(role: { readonly id: string; readonly system: string }, guidance: string): string {
  const text = guidance ? `${role.system}\n\n${guidance}` : role.system;
  return `${text}\n\n${skillTextFor(role)}`;
}

/** The role's system prompt with the guidance this deployment was given. */
export function specialistPrompt(role: { readonly id: string; readonly system: string }): string {
  return composeSpecialistPrompt(role, GUIDANCE);
}
