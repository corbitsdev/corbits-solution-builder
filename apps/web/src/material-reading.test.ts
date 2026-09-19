import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { readMaterial } from "./material-reading.ts";

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
