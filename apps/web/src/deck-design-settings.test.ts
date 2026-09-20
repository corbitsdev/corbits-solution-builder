import { describe, expect, test } from "bun:test";
import { DEFAULT_DECK_DESIGN } from "@solutions-builder/app/deck";
import { deckDesignFor, deckDesignKey, guidanceFor } from "./deck-design-settings.ts";

describe("deckDesignFor", () => {
  test("returns the default design when no preferences are saved", () => {
    expect(deckDesignFor("budget_approver", {})).toEqual(DEFAULT_DECK_DESIGN);
  });

  test("reads each role's saved values", () => {
    const preferences = {
      "deck.budget_approver.theme": "navy",
      "deck.budget_approver.typeface": "Georgia",
      "deck.budget_approver.density": "sparse",
      "deck.budget_approver.notes": false,
      "deck.budget_approver.images": "cover",
      "deck.budget_approver.guidance": "Lead with cost.",
    };
    expect(deckDesignFor("budget_approver", preferences)).toEqual({
      theme: "navy",
      typeface: "Georgia",
      density: "sparse",
      notes: false,
      images: "cover",
      template: null,
      guidance: "Lead with cost.",
    });
  });

  test("does not cross-contaminate roles", () => {
    const preferences = { "deck.budget_approver.theme": "navy" };
    expect(deckDesignFor("technical_approver", preferences).theme).toBe("ember");
  });

  test("falls back to defaults on bad preference values", () => {
    const preferences = {
      "deck.budget_approver.theme": "chartreuse",
      "deck.budget_approver.typeface": "Comic Sans",
      "deck.budget_approver.density": "extreme",
      "deck.budget_approver.notes": "yes",
      "deck.budget_approver.images": "always",
    };
    expect(deckDesignFor("budget_approver", preferences)).toEqual(DEFAULT_DECK_DESIGN);
  });
});

describe("guidanceFor", () => {
  test("is empty by default", () => {
    expect(guidanceFor("audience_member", {})).toBe("");
  });

  test("reads a role's saved guidance", () => {
    expect(guidanceFor("audience_member", { "deck.audience_member.guidance": "Keep it short." })).toBe("Keep it short.");
  });

  test("ignores a non-string value", () => {
    expect(guidanceFor("audience_member", { "deck.audience_member.guidance": 42 })).toBe("");
  });
});

describe("deckDesignKey", () => {
  test("namespaces a role's field", () => {
    expect(deckDesignKey("delivery_recipient", "theme")).toBe("deck.delivery_recipient.theme");
  });
});
