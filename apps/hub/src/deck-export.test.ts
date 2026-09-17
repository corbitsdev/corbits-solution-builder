import { describe, expect, test } from "bun:test";
import { DECK_MEDIA_TYPE, deckFrom } from "@solutions-builder/app/deck";

describe("@solutions-builder/app/deck", () => {
  test("the package export resolves and names the presentation media type", () => {
    expect(DECK_MEDIA_TYPE).toContain("presentationml.presentation");
    expect(typeof deckFrom).toBe("function");
  });
});
