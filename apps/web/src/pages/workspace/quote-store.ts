import type { Quote } from "../../client.js";

/**
 * Text a person has quoted into a stage's composer, kept across a send-back:
 * a stage that gets sent back and reopened later re-mounts its composer with
 * nothing attached, and the passages someone had already picked out would
 * otherwise be silently lost. Scoped to one project's stage — never a
 * project-wide key — and cleared once that stage is approved.
 */
function storageKey(tenantId: string, stage: number): string {
  return `sb.quoted-draft.${tenantId}.${stage}`;
}

export function loadQuotedDraft(tenantId: string, stage: number): Quote[] {
  try {
    const raw = localStorage.getItem(storageKey(tenantId, stage));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Quote => typeof entry === "object" && entry !== null && typeof (entry as Quote).quote === "string",
    );
  } catch {
    return [];
  }
}

export function saveQuotedDraft(tenantId: string, stage: number, quotes: readonly Quote[]): void {
  try {
    if (quotes.length === 0) {
      localStorage.removeItem(storageKey(tenantId, stage));
      return;
    }
    localStorage.setItem(storageKey(tenantId, stage), JSON.stringify(quotes));
  } catch {
    // Best-effort: the composer still works without persistence.
  }
}

export function clearQuotedDraft(tenantId: string, stage: number): void {
  try {
    localStorage.removeItem(storageKey(tenantId, stage));
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
