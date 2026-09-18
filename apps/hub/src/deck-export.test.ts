import { describe, expect, test } from "bun:test";
import { DECK_MEDIA_TYPE, deckFrom } from "@solutions-builder/app/deck";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("@solutions-builder/app/deck", () => {
  test("the package export resolves and names the presentation media type", () => {
    expect(DECK_MEDIA_TYPE).toContain("presentationml.presentation");
    expect(typeof deckFrom).toBe("function");
  });
});

describe("host deck persistence", () => {
  test("the host deck module only reads recorded slides — the sidecar renders them", async () => {
    const src = await readFile(join(here, "deck.ts"), "utf8");
    expect(src).not.toContain("renderDeckOnTemplate");
    expect(src).not.toContain("@solutions-builder/app/deck-on-template");
    expect(src).not.toContain("@solutions-builder/tools-deck/sidecar-bundle");
    expect(src).not.toMatch(/from ["']pptxgenjs["']/);
    expect(src).not.toContain("from \"./deck-images.js\"");
    expect(src).not.toContain("from \"./deck-settings.js\"");
    expect(src).not.toContain("from \"./deck-template.js\"");
  });

  test("the slides save route does not build a deck", async () => {
    const src = await readFile(join(here, "api-projects.ts"), "utf8");
    expect(src).toContain("deckForPackage");
    expect(src).not.toContain("ensureDeckFor");
    expect(src).not.toContain("writeDeckFor");
    expect(src).not.toContain("renderDeck");
  });
});
