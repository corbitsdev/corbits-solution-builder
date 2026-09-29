import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { deckFrom, renderDeck } from "@solutions-builder/app/deck";
import { readMaterial, readingHasText, slideXmlText } from "./material-reading.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function xlsxBytes(build: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

describe("readMaterial", () => {
  test("a text file is read verbatim", async () => {
    const { text } = await readMaterial({
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello world"),
    });
    expect(text).toBe("hello world");
  });

  test("a small workbook renders one block per sheet, with merges, formulas and formats", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("Budget");
      sheet.getCell("A1").value = "Item";
      sheet.getCell("B1").value = "Cost";
      sheet.mergeCells("A1:A1");
      sheet.getCell("A2").value = "Rent";
      sheet.getCell("B2").value = { formula: "100*2", result: 200 } as unknown as number;
      sheet.getCell("B2").numFmt = "$#,##0.00";
    });
    const { text } = await readMaterial({ name: "budget.xlsx", mediaType: XLSX_MIME, bytes });
    expect(text).toContain('Sheet "Budget"');
    expect(text).toContain("Item,Cost");
    expect(text).toContain("Rent");
    expect(text).toContain("Formulas:");
    expect(text).toContain("B2 =100*2");
    expect(text).toContain("Number formats:");
    expect(text).toContain("$#,##0.00");
  });

  test("a PowerPoint file is read as its slides' text, in order", async () => {
    const deck = deckFrom({
      projectTitle: "Acme",
      audience: "Finance",
      role: "budget_approver",
      markdown: "### Deck outline\n\n1. **The problem** — Costs are rising faster than revenue.\n2. **The plan** — Ship the pilot in Q1.\n\n### Decision request\n\n- Approve the pilot budget.\n",
    })!;
    const bytes = await renderDeck(deck);
    const { text } = await readMaterial({
      name: "last-year.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes,
    });
    expect(text).toStartWith("Slide 1 of 4:\nAcme");
    expect(text).toContain("Slide 2 of 4:\nThe problem");
    expect(text).toContain("Costs are rising faster than revenue.");
    expect(text.indexOf("The problem")).toBeLessThan(text.indexOf("The plan"));
    expect(text).not.toContain("<a:t>");
  });

  test("slide text joins runs within a paragraph and decodes entities", () => {
    const xml = '<p:sp><p:txBody><a:p><a:r><a:t>Costs &amp; </a:t></a:r><a:r><a:t>revenue</a:t></a:r></a:p><a:p></a:p><a:p><a:r><a:t xml:space="preserve"> Q1 </a:t></a:r></a:p></p:txBody></p:sp>';
    expect(slideXmlText(xml)).toBe("Costs & revenue\nQ1");
  });

  test("a reading is text when it was read, not when it is this module's own note", () => {
    expect(readingHasText("Page 1 of 3:\nHello")).toBe(true);
    expect(readingHasText("Slide 1 of 2:\nAcme")).toBe(true);
    expect(readingHasText("(3 pages, none carrying text: a scanned or image-only PDF. Nothing here reads images, so ask what it says if that matters.)")).toBe(false);
    expect(readingHasText("(Could not read deck.pdf: bad xref.)")).toBe(false);
    expect(readingHasText("   ")).toBe(false);
  });

  test("an unreadable type yields a short note with name, type and size", async () => {
    const { text } = await readMaterial({ name: "photo.png", mediaType: "image/png", bytes: new Uint8Array(10) });
    expect(text).toContain("photo.png");
    expect(text).toContain("image/png");
    expect(text).toContain("Nothing here reads this kind of file yet");
  });

  test("a row-cap overflow announces truncation rather than dropping rows silently", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("Big");
      for (let row = 1; row <= 2100; row += 1) sheet.getCell(`A${row}`).value = row;
    });
    const { text } = await readMaterial({ name: "big.xlsx", mediaType: XLSX_MIME, bytes });
    expect(text).toContain("(100 more rows not shown)");
  });

  test("a very long text file announces the characters left out", async () => {
    const long = "x".repeat(45_000);
    const { text } = await readMaterial({ name: "log.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(long) });
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("more characters not shown");
  });
});
