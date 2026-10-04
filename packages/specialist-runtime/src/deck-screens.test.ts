import { describe, expect, test } from "bun:test";
import { linesBox, outlineSlidesIn, screenHintOf, textScale } from "./deck.js";

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

// #676: lines that would run off the slide come down in size until they fit.
describe("textScale", () => {
  const box = linesBox(10, 5.625, false);
  test("a few short lines stay at full size", () => {
    expect(textScale(["One line.", "Two.", "Three."], box)).toBe(1);
    expect(textScale([], box)).toBe(1);
  });

  test("long lines shrink, the longer the more, and never below the floor", () => {
    const long = "A sentence long enough to wrap more than once across the width of the slide at the base size, and then some more words.";
    const some = textScale(Array.from({ length: 7 }, () => long), box);
    const many = textScale(Array.from({ length: 14 }, () => long), box);
    expect(some).toBeLessThan(1);
    expect(many).toBeLessThan(some);
    expect(many).toBeGreaterThanOrEqual(0.55);
    expect(textScale(Array.from({ length: 60 }, () => long), box)).toBe(0.55);
  });

  test("a picture beside the text narrows the box, so the same lines shrink sooner", () => {
    const lines = Array.from({ length: 6 }, () => "A line that is moderately long and wraps once or twice at the base size on the slide.");
    expect(textScale(lines, linesBox(10, 5.625, true))).toBeLessThanOrEqual(textScale(lines, linesBox(10, 5.625, false)));
  });
});
