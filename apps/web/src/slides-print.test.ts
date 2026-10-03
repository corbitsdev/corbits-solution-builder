import { describe, expect, test } from "bun:test";
import { deckFrom } from "@solutions-builder/app/deck";
import { slidesPrintHtml } from "./slides-print.ts";

const OUTLINE = `### Deck outline

1. **The problem** — Costs are rising & margins are thinning.
2. **The plan** — Ship the pilot in Q1.

### Decision request

- Approve the pilot budget.
`;

describe("slidesPrintHtml", () => {
  test("one page per slide at the renderer's size, text escaped, pictures where the deck has them", () => {
    const deck = deckFrom({ projectTitle: "Acme <Rebuild>", audience: "Finance", role: "Approver", markdown: OUTLINE });
    if (!deck) throw new Error("fixture outline did not build");
    const png = Uint8Array.of(137, 80, 78, 71);
    const html = slidesPrintHtml({ ...deck, images: new Map([["cover", png], ["1", png]]) }, "acme-rebuild-finance-slides");
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<title>acme-rebuild-finance-slides</title>");
    expect(html).toContain("@page { size: 10in 5.625in; margin: 0; }");
    expect((html.match(/<section class="slide /g) ?? []).length).toBe(4);
    expect(html).toContain("<h1>Acme &lt;Rebuild&gt;</h1>");
    expect(html).toContain("<li>— Costs are rising &amp; margins are thinning.</li>");
    expect(html).toContain("<h2>Decisions to Make</h2>");
    expect((html.match(/<img class="picture/g) ?? []).length).toBe(2);
    expect(html).toContain('class="cover-text with-picture"');
    expect(html).toContain('class="lines with-picture"');
    expect(html).toContain("Acme &lt;Rebuild&gt; · for Finance · 2");
  });

  test("a 4:3 look prints on a 7.5in page", () => {
    const deck = deckFrom({ projectTitle: "Acme", audience: "Finance", role: "Approver", markdown: OUTLINE, theme: { ratio: 4 / 3 } });
    if (!deck) throw new Error("fixture outline did not build");
    expect(slidesPrintHtml(deck, "t")).toContain("@page { size: 10in 7.5in; margin: 0; }");
  });
});
