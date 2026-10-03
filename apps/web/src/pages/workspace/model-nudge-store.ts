import { useStoredPreference, writeStoredPreference } from "../../stored-preference.ts";

/**
 * "Your primary is now X, switch this stage to it?" is dismissible, not
 * silence-forever: the person can keep the stage's model for *this* primary,
 * and the nudge stays quiet only until the primary moves again — at which
 * point it's a new question, not a repeat of the one already answered.
 * Scoped to one project's stage, never project-wide, so dismissing on stage 3
 * never suppresses it on stage 4.
 */
function dismissedKey(projectId: string, stage: number): string {
  return `sb.model-nudge-dismissed.${projectId}.${stage}`;
}

/** The primary's canonical model name the person last dismissed the nudge for, or "" if they never have. */
export function useDismissedPrimary(projectId: string, stage: number): string {
  return useStoredPreference(dismissedKey(projectId, stage), (raw) => raw, "");
}

export function dismissPrimary(projectId: string, stage: number, canonicalName: string): void {
  writeStoredPreference(dismissedKey(projectId, stage), canonicalName);
}

/**
 * What happens when a project's stage runs a model other than the primary:
 * ask each time, switch to the primary without asking, or keep the stage's
 * own and never ask.
 */
export type ModelMismatch = "ask" | "switch" | "keep";

const MODEL_MISMATCH_KEY = "solutions-builder-model-mismatch";

const parseModelMismatch = (raw: string): ModelMismatch | null => (raw === "ask" || raw === "switch" || raw === "keep" ? raw : null);

export function useModelMismatch(): ModelMismatch {
  return useStoredPreference(MODEL_MISMATCH_KEY, parseModelMismatch, "ask");
}

export function writeModelMismatch(choice: ModelMismatch): void {
  writeStoredPreference(MODEL_MISMATCH_KEY, choice);
}
