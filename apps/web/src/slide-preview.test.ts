import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DECK_DESIGN, type Deck } from "@solutions-builder/app/deck";
import { COVER_NOTE, previewSlides } from "./slide-preview.tsx";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

const deck: Deck = {
  projectTitle: "Workout Log",
  audience: "Finance",
  role: "cfo",
  slides: [
    { title: "The problem", bullets: ["Sets are lost between the rack and the phone"], notes: "" },
    { title: "The approach", bullets: ["Capture now, review later", "Pending until reviewed"], notes: "" },
  ],
  decision: ["Fund a two-week build"],
  design: DEFAULT_DECK_DESIGN,
};

// #95: the preview draws the same slides `renderDeck` writes, in the same
// order, with the same words, so what is on screen is what would be saved.
describe("the slides preview", () => {
  test("opens on the cover, then one slide per item, then the decision request", () => {
    const slides = previewSlides(deck);
    expect(slides.map((slide) => slide.title)).toEqual(["Workout Log", "The problem", "The approach", "Decision request"]);
    expect(slides[0]).toEqual({
      kind: "cover",
      title: "Workout Log",
      subtitle: "Prepared for Finance · cfo",
      note: COVER_NOTE,
    });
    expect(slides[1]).toEqual({ kind: "item", title: "The problem", lines: ["Sets are lost between the rack and the phone"], page: 2 });
    expect(slides[3]).toEqual({ kind: "item", title: "Decision request", lines: ["Fund a two-week build"], page: 4 });
  });

  test("a package that asks for no decision has no decision slide", () => {
    const slides = previewSlides({ ...deck, decision: [] });
    expect(slides).toHaveLength(3);
    expect(slides.at(-1)?.title).toBe("The approach");
  });

  test("the concept approval page draws it from the same outline, design and theme the download uses", () => {
    const page = read("./pages/audiences.tsx");
    expect(page).toContain("<SlidePreview key={selected.id} deck={preview.deck} note={preview.note} />");
    expect(page).toContain("packageOutlineProblem(content)");
    expect(page).toContain("api.deckTemplateThemeForRole(role)");
    expect(page).toContain("deckDesignFor(role, preferences)");
    expect(page).toContain("Pictures are drawn when the slides are saved.");
  });

  test("slides are laid out in container units against the stage and each thumb, never the slide itself", () => {
    const css = read("./styles.css");
    expect(css).toMatch(/\.slide-stage \{[^}]*container-type: inline-size;/s);
    expect(css).toMatch(/\.slide-thumb \{[^}]*container-type: inline-size;/s);
    expect(css).not.toMatch(/\.slide \{[^}]*container-type/s);
    expect(css).toContain('.slide-thumb[aria-current="true"] {');
  });
});
