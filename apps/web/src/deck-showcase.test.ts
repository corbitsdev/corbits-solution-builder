import { describe, expect, test } from "bun:test";
import { deckFrom, outlineSlidesIn, renderDeck } from "@solutions-builder/app/deck";
import { isShowcase, previewSlides } from "./slide-preview.tsx";
import { slidesPrintHtml } from "./slides-print.ts";

const OUTLINE = `### Deck outline

1. **The problem** — Costs are rising faster than revenue.
2. **What it looks like**
3. **The plan** — Ship the pilot in Q1.

### Decision request

- Approve the pilot budget.
`;

// #252: an outline item with nothing under it is a slide that shows a screen
// and says nothing else, drawn across the slide rather than beside empty lines.
describe("a \"What it looks like\" slide", () => {
  test("the parser keeps an item with nothing under it as a slide with no lines", () => {
    const slides = outlineSlidesIn(OUTLINE);
    expect(slides.map((slide) => slide.title)).toEqual(["The problem", "What it looks like", "The plan"]);
    expect(slides[1]!.bullets).toEqual([]);
  });

  test("the preview marks it a showcase only once it has a picture", () => {
    const bare = deckFrom({ projectTitle: "Acme", audience: "Finance", role: "budget_approver", markdown: OUTLINE })!;
    expect(previewSlides(bare).map(isShowcase)).toEqual([false, false, false, false, false]);
    const shown = { ...bare, images: new Map([["1", Uint8Array.of(1)]]) };
    expect(previewSlides(shown).map(isShowcase)).toEqual([false, false, true, false, false]);
  });

  test("the printed slide carries the picture full width", () => {
    const deck = deckFrom({ projectTitle: "Acme", audience: "Finance", role: "budget_approver", markdown: OUTLINE, images: new Map([["1", Uint8Array.of(1)], ["0", Uint8Array.of(2)]]) })!;
    const html = slidesPrintHtml(deck, "acme");
    expect(html).toContain('class="picture showcase"');
    expect(html).toContain(".picture.showcase { left: 0.5in; width: 9in; }");
    expect((html.match(/class="picture"/g) ?? []).length).toBe(1);
  });

  test("the renderer draws it", async () => {
    // A 1×1 PNG, so pptxgenjs has real image bytes to embed.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
    const deck = deckFrom({ projectTitle: "Acme", audience: "Finance", role: "budget_approver", markdown: OUTLINE, images: new Map([["1", png]]) })!;
    const bytes = await renderDeck(deck);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
