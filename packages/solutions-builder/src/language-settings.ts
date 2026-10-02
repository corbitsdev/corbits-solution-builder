/**
 * The workspace's languages (#411): what the person writes in, and what
 * every specialist writes in, documents and the software they build alike.
 * One person's preference for one workspace tenant, held under
 * `LANGUAGE_SETTINGS_CONFIG_KEY` in the tenant's own `config` the way the
 * designer settings are; the client writes it through
 * `@solutions-builder/installer`. This module is the shared shape, the
 * validation, and the instruction a specialist is given.
 */
import { type } from "arktype";

export const LANGUAGE_SETTINGS_CONFIG_KEY = "sb.languageSettings";

export const LANGUAGES = [
  { id: "en-US", label: "American English" },
  { id: "en-GB", label: "British English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
] as const;
export type LanguageId = (typeof LANGUAGES)[number]["id"];

/** The outputs the specialists are known to produce well today; the rest are listed but not yet offered. */
export const SUPPORTED_OUTPUT_LANGUAGES: readonly LanguageId[] = ["en-US", "en-GB"];

const Language = type("'en-US' | 'en-GB' | 'es' | 'fr' | 'de'");
const Settings = type({
  /** What the person writes their messages and material in. */
  input: Language,
  /** What the specialists write in: documents, replies, and the text of any software they build. */
  output: Language,
});
export type LanguageSettings = typeof Settings.infer;

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = { input: "en-US", output: "en-US" };

export function languageLabel(id: LanguageId): string {
  return LANGUAGES.find((language) => language.id === id)?.label ?? id;
}

/** Defaults filled in over whatever was read back, valid or not; never throws. */
export function parseLanguageSettings(raw: unknown): LanguageSettings {
  const parsed = Settings({ ...DEFAULT_LANGUAGE_SETTINGS, ...(typeof raw === "object" && raw !== null ? raw : {}) });
  return parsed instanceof type.errors ? DEFAULT_LANGUAGE_SETTINGS : parsed;
}

/** A patch merged onto a base, refusing a value the type rejects or an output not yet supported. */
export function mergeLanguageSettings(base: LanguageSettings, patch: Partial<LanguageSettings>): LanguageSettings {
  const next = Settings({ ...base, ...patch });
  if (next instanceof type.errors) throw new Error(`Language settings: ${next.summary}`);
  if (!SUPPORTED_OUTPUT_LANGUAGES.includes(next.output)) {
    throw new Error(`${languageLabel(next.output)} is not supported as an output language yet.`);
  }
  return next;
}

/** The spelling convention a specialist is told to follow, for the two Englishes. */
const SPELLING: Partial<Record<LanguageId, string>> = {
  "en-US": "American spelling and conventions (color, organize, license as a noun, MM/DD dates where a date is written out)",
  "en-GB": "British spelling and conventions (colour, organise, licence as a noun, DD/MM dates where a date is written out)",
};

/**
 * What the settings add to every specialist's instructions: the language of
 * everything it writes, including the user-facing text of software it
 * builds, and the language the person writes in when it differs.
 */
export function languageGuidance(settings: LanguageSettings): string {
  const output = languageLabel(settings.output);
  const spelling = SPELLING[settings.output];
  const lines = [
    `Write in ${output}${spelling ? `, with ${spelling}` : ""}: every document, every reply, and all user-facing text, labels, messages and documentation in any software you build. Code identifiers follow the conventions of their language and libraries.`,
  ];
  if (settings.input !== settings.output) {
    lines.push(`The person writes in ${languageLabel(settings.input)}; read it as such, and still answer in ${output}.`);
  }
  return lines.join(" ");
}

/** The one line that leads a stage's opening mail, so a running specialist hears a changed setting at once. */
export function languageLead(settings: LanguageSettings): string {
  return `Language: ${languageGuidance(settings)}`;
}
