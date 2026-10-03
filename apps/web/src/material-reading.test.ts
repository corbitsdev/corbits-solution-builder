import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { deckFrom, renderDeck } from "@solutions-builder/app/deck";
import JSZip from "jszip";
import { readMaterial, readingHasText, slideXmlText, wordXmlText } from "./material-reading.ts";

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

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

/** A Word file as Word writes one: a zip whose `word/document.xml` holds the body. */
async function docxBytes(body: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

const paragraph = (text: string, properties = "") =>
  `<w:p w:rsidR="00A1">${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("readMaterial, Word files (#609)", () => {
  test("a Word file is read as its text in document order: headings, paragraphs, list items and table rows", async () => {
    const bytes = await docxBytes(
      [
        paragraph("Lead handling", '<w:pStyle w:val="Title"/>'),
        paragraph("What hurts", '<w:pStyle w:val="Heading2"/>'),
        paragraph("Leads go cold &amp; nobody notices."),
        "<w:p/>",
        paragraph("Sales", '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        paragraph("Support", '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        `<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:trPr/><w:tc><w:tcPr/>${paragraph("Team")}</w:tc><w:tc>${paragraph("Leads")}</w:tc></w:tr><w:tr><w:tc>${paragraph("East")}</w:tc><w:tc>${paragraph("40")}</w:tc></w:tr></w:tbl>`,
        paragraph("Signed off by finance."),
      ].join(""),
    );
    const { text } = await readMaterial({ name: "brief.docx", mediaType: DOCX_MIME, bytes });
    expect(text).toBe(
      ["# Lead handling", "## What hurts", "Leads go cold & nobody notices.", "- Sales\n- Support", "Team | Leads\nEast | 40", "Signed off by finance."].join("\n\n"),
    );
  });

  test("a Word file the browser gave no type for is known by its name", async () => {
    const bytes = await docxBytes(paragraph("Only the name says what this is."));
    const { text } = await readMaterial({ name: "Notes.DOCX", mediaType: "application/octet-stream", bytes });
    expect(text).toBe("Only the name says what this is.");
  });

  test("a Word file with no text says so, in a note rather than as text", async () => {
    const { text } = await readMaterial({ name: "blank.docx", mediaType: DOCX_MIME, bytes: await docxBytes("<w:p/><w:p><w:r><w:drawing/></w:r></w:p>") });
    expect(text).toStartWith("(A Word file carrying no text");
    expect(readingHasText(text)).toBe(false);
  });

  test("a file named .docx that is not a Word document fails rather than reading as blank", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(readMaterial({ name: "fake.docx", mediaType: DOCX_MIME, bytes })).rejects.toThrow("not a Word document");
  });

  test("the older binary Word file is still described, not read", async () => {
    const { text } = await readMaterial({ name: "old.doc", mediaType: "application/msword", bytes: new Uint8Array(2048) });
    expect(text).toStartWith("(A file attached: old.doc, application/msword, 2 KB.");
  });
});

describe("wordXmlText", () => {
  test("a tab and a line break are text; a tab stop, a tracked deletion and a field's code are not", () => {
    const xml =
      "<w:p><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"720\"/></w:tabs></w:pPr>" +
      "<w:r><w:t>Name</w:t><w:tab/><w:t>Role</w:t><w:br/><w:t>Ada</w:t></w:r>" +
      "<w:del><w:r><w:delText>struck out</w:delText></w:r></w:del>" +
      "<w:r><w:instrText> PAGEREF _Toc1 </w:instrText></w:r>" +
      "<w:ins><w:r><w:t xml:space=\"preserve\"> Lovelace</w:t></w:r></w:ins></w:p>";
    expect(wordXmlText(xml)).toBe("Name\tRole\nAda Lovelace");
  });

  test("a text box is read once, after the body, and does not cut the paragraph it is anchored to", () => {
    const box = "<w:txbxContent><w:p><w:r><w:t>In the box</w:t></w:r></w:p></w:txbxContent>";
    const xml =
      `<w:p><w:r><w:t>Before</w:t></w:r><w:r><mc:AlternateContent><mc:Choice>${box}</mc:Choice><mc:Fallback>${box}</mc:Fallback></mc:AlternateContent></w:r>` +
      "<w:r><w:t> and after.</w:t></w:r></w:p><w:p><w:r><w:t>Next.</w:t></w:r></w:p>";
    expect(wordXmlText(xml)).toBe("Before and after.\n\nNext.\n\nIn the box");
  });

  test("character references are decoded", () => {
    expect(wordXmlText("<w:p><w:r><w:t>R&amp;D &#8212; 5 &lt; 6 &#x2713;</w:t></w:r></w:p>")).toBe("R&D — 5 < 6 ✓");
  });
});
