/**
 * "Your default model is now X, switch this stage to it?" is dismissible,
 * not silence-forever: the person can say "keep the current model" for
 * *this* default, and the nudge stays quiet only until the workspace
 * default moves again — at which point it's a new question, not a repeat
 * of the one already answered. Scoped to one project's stage, never
 * project-wide, so dismissing on stage 3 never suppresses it on stage 4.
 */
function storageKey(projectId: string, stage: number): string {
  return `sb.model-nudge-dismissed.${projectId}.${stage}`;
}

/** The default's canonical model name the person last dismissed the nudge
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
