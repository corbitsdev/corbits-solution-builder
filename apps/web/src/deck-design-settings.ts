/**
 * A stakeholder role's deck design and outline guidance, as saved
 * preferences. Pure: given a role and the preferences map `api.preferences()`
 * returns, resolves the `DeckDesign` that role's slides are built with and
 * the free-text guidance its outline is drafted with.
 *
 * The style guide (a PowerPoint template mapped to a role) is a separate
 * mechanism — `deck-templates.ts` and `client.ts`'s `deckSettings` — and is
 * not read here; its theme is applied over these settings by the caller, the
 * same way `lookOf` in `deck.ts` already lets a style guide's theme win.
 */
import { DECK_DENSITY, DECK_THEMES, DEFAULT_DECK_DESIGN, type DeckDensity, type DeckDesign, type DeckTheme, type DeckTypeface } from "@solutions-builder/app/deck";

const DECK_TYPEFACE_VALUES = ["Calibri", "Georgia", "Arial", "Helvetica"] as const satisfies readonly DeckTypeface[];
const DECK_IMAGES_VALUES = ["none", "cover", "some", "all"] as const satisfies readonly DeckDesign["images"][];

/** The `preferences` key a role's design field is saved under. */
export function deckDesignKey(role: string, field: "theme" | "typeface" | "density" | "notes" | "images" | "guidance"): string {
  return `deck.${role}.${field}`;
}

function theme(value: unknown): DeckTheme {
  return typeof value === "string" && value in DECK_THEMES ? (value as DeckTheme) : DEFAULT_DECK_DESIGN.theme;
}

function typeface(value: unknown): DeckTypeface {
  return typeof value === "string" && (DECK_TYPEFACE_VALUES as readonly string[]).includes(value) ? (value as DeckTypeface) : DEFAULT_DECK_DESIGN.typeface;
}

function density(value: unknown): DeckDensity {
  return typeof value === "string" && value in DECK_DENSITY ? (value as DeckDensity) : DEFAULT_DECK_DESIGN.density;
}

function notes(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_DECK_DESIGN.notes;
}

function images(value: unknown): DeckDesign["images"] {
  return typeof value === "string" && (DECK_IMAGES_VALUES as readonly string[]).includes(value) ? (value as DeckDesign["images"]) : DEFAULT_DECK_DESIGN.images;
}

/**
 * The `DeckDesign` a role's slides are built with, from saved preferences.
 * Every field is validated against its known values and falls back to
 * `DEFAULT_DECK_DESIGN` on anything else — a stale or hand-edited
 * preference never breaks a build. `template` is left at its default: which
 * style guide (if any) is mapped to the role is a separate setting, applied
 * by the caller as a `TemplateTheme` over this design's colours and
 * typeface.
 */
export function deckDesignFor(role: string, preferences: Record<string, unknown>): DeckDesign {
  return {
    theme: theme(preferences[deckDesignKey(role, "theme")]),
    typeface: typeface(preferences[deckDesignKey(role, "typeface")]),
    density: density(preferences[deckDesignKey(role, "density")]),
    notes: notes(preferences[deckDesignKey(role, "notes")]),
    images: images(preferences[deckDesignKey(role, "images")]),
    template: DEFAULT_DECK_DESIGN.template,
    guidance: guidanceFor(role, preferences),
  };
}

/**
 * What a role's deck outline should emphasise, in the person's words. Given
 * to the presentation creator when a package is drafted for that role, not
 * to the renderer — the deck itself carries no trace of it.
 */
export function guidanceFor(role: string, preferences: Record<string, unknown>): string {
  const value = preferences[deckDesignKey(role, "guidance")];
  return typeof value === "string" ? value : DEFAULT_DECK_DESIGN.guidance;
}
