import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import type { DeckDesign } from "@solutions-builder/app/deck";
import { buildPackageDeck } from "./deck-save.ts";

const OUTLINE = `# Audience package

### Deck outline

1. **The problem** — Costs are rising faster than revenue. It compounds monthly. Margins are thinning. Customers are noticing. Competitors are not slowing down.
2. **The plan** — Ship the pilot in Q1. It is scoped tight. It costs little. It proves the model. It de-risks the rest.

### Decision request

- Approve the pilot budget.
`;

const BASE_DESIGN: DeckDesign = { theme: "ember", typeface: "Calibri", density: "standard", notes: true, images: "none", template: null, guidance: "" };
const ARGS = { projectTitle: "Acme Rebuild", audience: "Finance", role: "Approver", markdown: OUTLINE };

async function slideXml(dataUrl: string, path: string): Promise<string> {
  const base64 = dataUrl.split(",")[1]!;
  const zip = await JSZip.loadAsync(base64, { base64: true });
  const entry = zip.file(path);
  if (!entry) throw new Error(`${path} not found in pptx`);
  return entry.async("string");
}

describe("buildPackageDeck", () => {
  test("builds a non-empty pptx from a fixture outline", async () => {
    const result = await buildPackageDeck({
      projectTitle: "Acme Rebuild",
      audience: "Finance",
      role: "Approver",
      markdown: OUTLINE,
    });
    expect(result.filename).toBe("acme-rebuild-finance-slides.pptx");
    expect(result.dataUrl.startsWith("data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,")).toBe(true);
    const base64 = result.dataUrl.split(",")[1]!;
    expect(base64.length).toBeGreaterThan(100);
  });

  test("throws a clear error when the outline is missing", async () => {
    await expect(
      buildPackageDeck({
        projectTitle: "Acme Rebuild",
        audience: "Finance",
        role: "Approver",
        markdown: "# Audience package\n\nNo outline here.\n",
      }),
    ).rejects.toThrow(/no "### Deck outline" section/);
  });

  test("a themed deck's bytes differ from the default deck's", async () => {
    const args = { projectTitle: "Acme Rebuild", audience: "Finance", role: "Approver", markdown: OUTLINE };
    const plain = await buildPackageDeck(args);
    const themed = await buildPackageDeck({ ...args, theme: { accent: "112233", titleFace: "Georgia" } });
    expect(themed.dataUrl).not.toBe(plain.dataUrl);
  });

  test("a role's design changes the built deck's bytes", async () => {
    const plain = await buildPackageDeck(ARGS);
    const designed = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, theme: "navy", typeface: "Georgia", density: "sparse", notes: false } });
    expect(designed.dataUrl).not.toBe(plain.dataUrl);
  });

  test("theme changes the accent colour drawn on slides", async () => {
    const ember = await buildPackageDeck({ ...ARGS, design: BASE_DESIGN });
    const navy = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, theme: "navy" } });
    const [emberXml, navyXml] = await Promise.all([slideXml(ember.dataUrl, "ppt/slides/slide1.xml"), slideXml(navy.dataUrl, "ppt/slides/slide1.xml")]);
    expect(emberXml).toContain("B45309");
    expect(navyXml).toContain("1E3A8A");
    expect(navyXml).not.toContain("B45309");
  });

  test("typeface names the font used in the pptx XML", async () => {
    const calibri = await buildPackageDeck({ ...ARGS, design: BASE_DESIGN });
    const georgia = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, typeface: "Georgia" } });
    const [calibriXml, georgiaXml] = await Promise.all([slideXml(calibri.dataUrl, "ppt/slides/slide2.xml"), slideXml(georgia.dataUrl, "ppt/slides/slide2.xml")]);
    expect(calibriXml).toContain('typeface="Calibri"');
    expect(georgiaXml).toContain('typeface="Georgia"');
    expect(georgiaXml).not.toContain('typeface="Calibri"');
  });

  test("density bounds how many bullets an item's slide carries", async () => {
    const sparse = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, density: "sparse" } });
    const full = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, density: "full" } });
    const [sparseXml, fullXml] = await Promise.all([slideXml(sparse.dataUrl, "ppt/slides/slide2.xml"), slideXml(full.dataUrl, "ppt/slides/slide2.xml")]);
    const bulletCount = (xml: string) => (xml.match(/<a:buChar/g) ?? []).length;
    expect(bulletCount(sparseXml)).toBeLessThan(bulletCount(fullXml));
    expect(bulletCount(sparseXml)).toBeLessThanOrEqual(3);
    expect(bulletCount(fullXml)).toBeGreaterThan(3);
  });

  test("speaker notes on fills a slide's notesSlide part, off leaves it empty", async () => {
    const withNotes = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, notes: true } });
    const withoutNotes = await buildPackageDeck({ ...ARGS, design: { ...BASE_DESIGN, notes: false } });
    const [withXml, withoutXml] = await Promise.all([
      slideXml(withNotes.dataUrl, "ppt/notesSlides/notesSlide2.xml"),
      slideXml(withoutNotes.dataUrl, "ppt/notesSlides/notesSlide2.xml"),
    ]);
    expect(withXml).toContain("Costs are rising faster than revenue.");
    expect(withoutXml).not.toContain("Costs are rising faster than revenue.");
  });

  test("a style guide's theme wins over the design's colour and typeface", async () => {
    const args = { ...ARGS, design: { ...BASE_DESIGN, theme: "navy" as const, typeface: "Georgia" as const } };
    const withoutStyleGuide = await buildPackageDeck(args);
    const withStyleGuide = await buildPackageDeck({ ...args, theme: { accent: "112233", titleFace: "Arial", bodyFace: "Arial" } });
    const [plainXml, styledXml] = await Promise.all([slideXml(withoutStyleGuide.dataUrl, "ppt/slides/slide2.xml"), slideXml(withStyleGuide.dataUrl, "ppt/slides/slide2.xml")]);
    expect(plainXml).toContain('typeface="Georgia"');
    expect(styledXml).toContain('typeface="Arial"');
    expect(styledXml).not.toContain('typeface="Georgia"');
  });
});
