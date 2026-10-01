/**
 * Per-stakeholder-role deck preferences — each role's slide look and the
 * guidance its outline is drafted with — held under `DECK_DESIGNS_CONFIG_KEY`
 * in the workspace tenant's `config`, the way `designer-settings.ts` holds
 * the designer's.
 *
 * The value is the flat preference map the folds in
 * `apps/web/src/deck-design-settings.ts` already read: `deck.<role>.<field>`
 * keys. Field validation lives in those folds; this module is the envelope.
 */

export const DECK_DESIGNS_CONFIG_KEY = "sb.deckDesigns";

export type DeckDesignPreferences = Record<string, unknown>;

/** The map as saved on the tenant, or empty for anything unreadable; never throws. */
export function parseDeckDesignPreferences(raw: unknown): DeckDesignPreferences {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as DeckDesignPreferences)
    : {};
}
