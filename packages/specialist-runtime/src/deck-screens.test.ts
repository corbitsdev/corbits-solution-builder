import { describe, expect, test } from "bun:test";
import { outlineSlidesIn, screenHintOf } from "./deck.js";

// #302: an outline item may name the design screen its slide shows.
describe("screen hints", () => {
  test("an item's (screen: name) marker names its slide's screen and leaves its words", () => {
    const slides = outlineSlidesIn(`### Deck outline

1. **What it looks like** (screen: dashboard)
   The PMO sees every project on one page. Status is colour.
2. **Timeline** — Days, not weeks. (screen: Gantt view)
3. **Cost** — Rough figures only.
`);
    expect(slides.map((slide) => slide.screen ?? null)).toEqual(["dashboard", "Gantt view", null]);
    expect(slides[0]!.title).toBe("What it looks like");
    expect(slides[1]!.notes).toBe("— Days, not weeks.");
    expect(slides[1]!.bullets.join(" ")).not.toContain("screen:");
  });

  test("screenHintOf is case-insensitive and tidies the space it leaves", () => {
    expect(screenHintOf("Value ( Screen: Phone home ) for everyone")).toEqual({ screen: "Phone home", text: "Value for everyone" });
    expect(screenHintOf("No marker here")).toEqual({ screen: null, text: "No marker here" });
  });
});
