import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LANGUAGE_SETTINGS,
  LANGUAGES,
  SUPPORTED_OUTPUT_LANGUAGES,
  languageGuidance,
  languageLead,
  mergeLanguageSettings,
  parseLanguageSettings,
} from "./language-settings.ts";

describe("language settings", () => {
  test("American English is the default for both, and the five languages are offered", () => {
    expect(DEFAULT_LANGUAGE_SETTINGS).toEqual({ input: "en-US", output: "en-US" });
    expect(LANGUAGES.map((l) => l.label)).toEqual(["American English", "British English", "Spanish", "French", "German"]);
    expect(SUPPORTED_OUTPUT_LANGUAGES).toEqual(["en-US", "en-GB"]);
  });

  test("a bad or missing value reads as the default; an unsupported output is refused on save", () => {
    expect(parseLanguageSettings(undefined)).toEqual(DEFAULT_LANGUAGE_SETTINGS);
    expect(parseLanguageSettings({ output: "en-GB" })).toEqual({ input: "en-US", output: "en-GB" });
    expect(parseLanguageSettings({ output: "klingon" })).toEqual(DEFAULT_LANGUAGE_SETTINGS);
    expect(mergeLanguageSettings(DEFAULT_LANGUAGE_SETTINGS, { input: "fr" })).toEqual({ input: "fr", output: "en-US" });
    expect(() => mergeLanguageSettings(DEFAULT_LANGUAGE_SETTINGS, { output: "fr" })).toThrow(/French is not supported as an output language yet/);
  });

  test("the guidance names the language, its spelling, the software's text, and the person's language when it differs", () => {
    const us = languageGuidance(DEFAULT_LANGUAGE_SETTINGS);
    expect(us).toContain("Write in American English");
    expect(us).toContain("color, organize");
    expect(us).toContain("software you build");
    expect(us).not.toContain("The person writes in");
    const gb = languageGuidance({ input: "es", output: "en-GB" });
    expect(gb).toContain("Write in British English");
    expect(gb).toContain("colour, organise");
    expect(gb).toContain("The person writes in Spanish");
    expect(languageLead(DEFAULT_LANGUAGE_SETTINGS)).toStartWith("Language: Write in American English");
  });
});
