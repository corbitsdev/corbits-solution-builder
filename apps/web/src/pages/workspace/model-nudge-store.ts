import { useSyncExternalStore } from "react";

/**
 * "Your primary is now X, switch this stage to it?" is dismissible, not
 * silence-forever: the person can keep the stage's model for *this* primary,
 * and the nudge stays quiet only until the primary moves again — at which
 * point it's a new question, not a repeat of the one already answered.
 * Scoped to one project's stage, never project-wide, so dismissing on stage 3
 * never suppresses it on stage 4.
 */
function storageKey(projectId: string, stage: number): string {
  return `sb.model-nudge-dismissed.${projectId}.${stage}`;
}

/** The primary's canonical model name the person last dismissed the nudge
 *  for, or null if they never have (or storage is unavailable). */
export function loadDismissedDefault(projectId: string, stage: number): string | null {
  try {
    return localStorage.getItem(storageKey(projectId, stage));
  } catch {
    return null;
  }
}

export function saveDismissedDefault(projectId: string, stage: number, canonicalName: string): void {
  try {
    localStorage.setItem(storageKey(projectId, stage), canonicalName);
  } catch {
    // Best-effort: a lost dismissal just means the nudge asks again next time.
  }
}

/**
 * What happens when a project's stage runs a model other than the primary:
 * ask each time, switch to the primary without asking, or keep the stage's
 * own and never ask. A preference of this person in this browser, like the
 * dismissals above; blocked storage keeps it for as long as the window lives.
 */
export type ModelMismatch = "ask" | "switch" | "keep";

export const MODEL_MISMATCH_KEY = "solutions-builder-model-mismatch";

const listeners = new Set<() => void>();
let current: ModelMismatch | null = null;

export function readModelMismatch(): ModelMismatch {
  if (current === null) {
    try {
      const stored = localStorage.getItem(MODEL_MISMATCH_KEY);
      current = stored === "switch" || stored === "keep" ? stored : "ask";
    } catch {
      current = "ask";
    }
  }
  return current;
}

export function writeModelMismatch(choice: ModelMismatch): void {
  current = choice;
  try {
    if (choice === "ask") localStorage.removeItem(MODEL_MISMATCH_KEY);
    else localStorage.setItem(MODEL_MISMATCH_KEY, choice);
  } catch {
    // Blocked storage: the choice still holds until the window closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // Another window changed it: read it again.
  const onStorage = () => {
    current = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useModelMismatch(): ModelMismatch {
  return useSyncExternalStore(subscribe, readModelMismatch, () => "ask");
}
