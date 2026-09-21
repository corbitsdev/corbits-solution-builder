/**
 * Per-stakeholder-role deck preferences — each role's slide look and the
 * guidance its outline is drafted with — held as a hub asset on the
 * workspace tenant, the way `designer-settings.ts` holds the designer's.
 *
 * The asset carries the flat preference map the folds in
 * `apps/web/src/deck-design-settings.ts` already read: `deck.<role>.<field>`
 * keys. Field validation lives in those folds; this module is the envelope.
 */

export const DECK_DESIGNS_ASSET_KIND = "deck-designs";
export const DECK_DESIGNS_ASSET_NAME = "deck-designs";
export const DECK_DESIGNS_PATH = "deck-designs.json";

export type DeckDesignPreferences = Record<string, unknown>;

/** The map as saved on the tenant, or empty for anything unreadable; never throws. */
export function parseDeckDesignPreferences(raw: unknown): DeckDesignPreferences {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as DeckDesignPreferences)
    : {};
}
