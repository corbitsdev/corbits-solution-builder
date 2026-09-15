/**
 * How each stakeholder role's deck is designed, and what its outline should
 * emphasise. One design per role, since a budget approver and a technical
 * approver do not want the same slides; a role with nothing saved takes the
 * default. Kept in a file beside the designer's settings and read twice: when
 * the presentation creator writes the package (the guidance goes into its
 * prompt) and when the deck is built from the package (the look).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { type } from "arktype";
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import { DEFAULT_DECK_DESIGN, type DeckDesign } from "@solutions-builder/app/deck";
import { HostError } from "./errors.js";
import { deckSettingsFile } from "./paths.js";

export { DEFAULT_DECK_DESIGN, type DeckDesign };

/** The roles a stakeholder can hold; each has a deck design of its own. */
export const DECK_ROLES: readonly Authority[] = AUTHORITIES.filter((role) => role !== "system");

// The look and content shape a design can take (theme, typeface, density,
// what illustrations to draw) is the authoring provider's — the deck
// package's — typed input; this file only validates and persists it per
// role.
const Design = type({
  theme: "'ember' | 'slate' | 'forest' | 'navy' | 'plum'",
  typeface: "'Calibri' | 'Georgia' | 'Arial' | 'Helvetica'",
  density: "'sparse' | 'standard' | 'full'",
  /** Whether each slide carries the item's full text as speaker notes. */
  notes: "boolean",
  /**
   * Which slides carry an illustration: none; the cover; some, chosen by a
   * model that has read the deck; or the cover and every slide. In every
   * case but none, the same model reads the deck and says what each picture
   * should show.
   */
  images: "'none' | 'cover' | 'some' | 'all'",
  /** The file name of the PowerPoint kept as this role's style guide, or null. */
  template: "string | null",
  /** What this role's deck outline should emphasise, in the person's words; given to the presentation creator. */
  guidance: "string",
});

export type DeckSettings = Record<Authority, DeckDesign>;

function withDefaults(raw: unknown): DeckSettings {
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<string, DeckDesign>;
  for (const role of DECK_ROLES) {
    const parsed = Design({ ...DEFAULT_DECK_DESIGN, ...((stored[role] as object | undefined) ?? {}) });
    out[role] = parsed instanceof type.errors ? DEFAULT_DECK_DESIGN : parsed;
  }
  return out as DeckSettings;
}

/** Every role's design as saved, with the default for anything missing or unreadable. */
export async function deckSettings(): Promise<DeckSettings> {
  try {
    return withDefaults(JSON.parse(await readFile(deckSettingsFile(), "utf8")));
  } catch {
    return withDefaults({});
  }
}

/** The design for one role: a role the ledger does not know takes the default. */
export async function deckDesignFor(role: string): Promise<DeckDesign> {
  const all = await deckSettings();
  return (all as Record<string, DeckDesign>)[role] ?? DEFAULT_DECK_DESIGN;
}

/**
 * Saves are one after another. A save reads the whole file, changes one
 * role and writes the whole file back; two in flight at once — six selects
 * changed while the host was busy — each wrote the other's change away,
 * and every second role came back unchanged.
 */
let writing: Promise<unknown> = Promise.resolve();

/** Saves a change to one role's design, refusing a value the type rejects. */
export function saveDeckDesign(role: string, patch: Partial<DeckDesign>): Promise<DeckDesign> {
  const turn = writing.then(() => writeDeckDesign(role, patch));
  writing = turn.catch(() => undefined);
  return turn;
}

async function writeDeckDesign(role: string, patch: Partial<DeckDesign>): Promise<DeckDesign> {
  if (!(DECK_ROLES as readonly string[]).includes(role)) {
    throw new HostError("validation_failed", `${role} is not a stakeholder role.`);
  }
  const all = await deckSettings();
  const next = Design({ ...(all as Record<string, DeckDesign>)[role], ...patch });
  if (next instanceof type.errors) {
    throw new HostError("validation_failed", `Deck design for ${role.replace(/_/g, " ")}: ${next.summary}`);
  }
  const saved = { ...all, [role]: next };
  const file = deckSettingsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
  return next;
}

/** A short fingerprint of the look a deck was built with, so a changed design builds a new version. */
export function deckDesignHash(design: DeckDesign, extra: unknown = null): string {
  const { guidance: _guidance, ...look } = design;
  return createHash("sha256").update(JSON.stringify([look, extra])).digest("hex").slice(0, 16);
}

/** What the role's design adds to the presentation creator's instructions for that stakeholder's package. */
export function deckGuidance(role: string, design: DeckDesign): string | null {
  const guidance = design.guidance.trim();
  if (!guidance) return null;
  return [
    `Deck outline for a ${role.replace(/_/g, " ")}, in the person's own words. Follow it in what the outline covers and leads with:`,
    guidance,
  ].join("\n");
}
