/**
 * What the person hands over with the problem reaches the specialists.
 *
 * A CSV, a spreadsheet and an image are attached to a project. Each becomes a
 * source_material version of its own type; the prompt inputs for stage 1 —
 * where nothing approved exists yet — carry the CSV as text, the spreadsheet
 * as one CSV block per sheet, and the image by name with a plain note that
 * nothing here reads images. A type the product cannot keep is refused, and
 * the same file name again is a new version, not a second row.
 *
 * Usage: bun --conditions intx-src scripts/material-smoke.ts
 */
import ExcelJS from "exceljs";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub, localActor } from "../apps/hub/src/hub-client.js";
import { install } from "../apps/hub/src/install.js";
import { createProject, projectDetail, readArtifactNode } from "../apps/hub/src/projects.js";
import * as XLSX from "xlsx";
import { attachMaterial, materialText, pdfText, spreadsheetText, bytesOf } from "../apps/hub/src/source-material.js";
import { stageInputsForSmoke } from "../apps/hub/src/stage-runs.js";
import { HostError } from "../apps/hub/src/errors.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const host = await openDatabase(
  process.env.SOLUTIONS_BUILDER_DATA_DIR ? `${process.env.SOLUTIONS_BUILDER_DATA_DIR}/pglite-material` : undefined,
);
await prepareDatabase(host);
await ensureHub();
await install();
const ACTOR = { ...localActor(), displayName: "Material smoke" };

const created = await createProject({
  title: "Material smoke",
  owner: ACTOR,
  policy: { costTolerancePercent: 10, costToleranceAbsolute: 100, audiences: [], audienceQuorum: 0, allowExternalProviders: true },
  problemStatement: "The weekly invoicing runs off this spreadsheet and takes a whole afternoon.",
});

// A workbook with two sheets, as a person would hand over.
const workbook = new ExcelJS.Workbook();
const invoices = workbook.addWorksheet("Invoices");
invoices.columns = [{ width: 18 }, { width: 10 }, {}];
invoices.addRow(["Client", "Amount", "Due"]);
invoices.addRow(["Acme", 1200, "2026-09-30"]);
invoices.addRow(["Globex, Inc", 850.5, "2026-10-05"]);
invoices.addRow(["Total", { formula: "SUM(B2:B3)", result: 2050.5 }, new Date("2026-10-31T00:00:00Z")]);
invoices.getCell("B2").numFmt = "#,##0.00";
invoices.getCell("B3").numFmt = "#,##0.00";
invoices.getCell("B4").numFmt = "#,##0.00";
invoices.getCell("C4").numFmt = "yyyy-mm-dd";
invoices.mergeCells("A6:C6");
invoices.getCell("A6").value = "Signed off by finance";
const notes = workbook.addWorksheet("Notes");
notes.addRow(["Every Friday, copy last week's rows and bump the dates."]);
const xlsx = new Uint8Array(await workbook.xlsx.writeBuffer());
const csv = new TextEncoder().encode("step,owner,minutes\nExport report,Sam,20\nEmail clients,Sam,45\n");
// A 1x1 PNG.
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

const attached = await attachMaterial({
  projectId: created.projectId,
  actor: ACTOR,
  alreadyHeldBytes: 0,
  files: [
    { name: "process.csv", type: "text/csv", bytes: csv },
    { name: "invoices.xlsx", type: "", bytes: xlsx },
    { name: "board.png", type: "image/png", bytes: png },
  ],
});
check("three files become three material versions", attached.length === 3, attached.map((entry) => `${entry.name}:${entry.mediaType}`).join(", "));
check("a spreadsheet's type comes from its name when the browser gave none", attached[1]?.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

const detail = await projectDetail(created.projectId, ACTOR.principalId);
const material = detail.nodes.filter((node) => node.kind === "source_material");
check("each is a source_material node at stage 1, its own row", material.length === 3 && material.every((node) => node.stage === 1) && new Set(material.map((node) => node.variant)).size === 3);
const image = material.find((node) => node.title === "board.png")!;
const stored = bytesOf((await readArtifactNode(image.id)).content);
check("an image's bytes are kept whole", stored !== null && stored.bytes.byteLength === png.byteLength && stored.mime === "image/png");

const rendered = await stageInputsForSmoke(created.projectId, 1);
check("stage 1 is handed the material although nothing is approved yet", rendered.includes("MATERIAL THE PERSON PROVIDED: process.csv"));
check("the CSV goes as its own text", rendered.includes("Email clients,Sam,45"));
check("the spreadsheet goes as one block per sheet, its values as CSV", rendered.includes('Sheet "Invoices" (A1:C6, 5 rows × 3 columns)') && rendered.includes('"Globex, Inc",850.5,2026-10-05') && rendered.includes('Sheet "Notes"'), rendered.match(/Sheet "Invoices"[^\n]*/)?.[0] ?? "no Invoices block");
check("with what CSV cannot carry: the formula, the merge, the widths and the number formats", rendered.includes("Formulas:\nB4 =SUM(B2:B3) → 2050.5") && rendered.includes("Merged: A6:C6") && rendered.includes("Column widths: A 18, B 10") && rendered.includes("#,##0.00 at B2, B3, B4") && rendered.includes("yyyy-mm-dd at C4"), rendered.slice(rendered.indexOf("Merged"), rendered.indexOf("Merged") + 200));
check("a date cell reads as a date, not as the runtime prints one", rendered.includes("Total,2050.5,2026-10-31") && !rendered.includes("GMT"));
check("the image goes by name, with a plain note that it was not read", rendered.includes("board.png") && rendered.includes("nothing here reads images"));
check("nothing claims to have read the image", !/read the image|the image shows/i.test(rendered));

// A PDF written by hand, with no cross-reference table — the shape a tolerant
// reader has to cope with anyway — and one with no text at all.
const pdfOf = (content: string) =>
  new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
      `4 0 obj << /Length ${content.length} >> stream`,
      content,
      "endstream endobj",
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
  );
const brief = await pdfText(pdfOf("BT /F1 24 Tf 72 700 Td (The executive brief: prove the invoice flow first) Tj ET"));
check("a PDF's text is read, page by page", brief.includes("Page 1 of 1") && brief.includes("prove the invoice flow first"), brief.slice(0, 120));
const scan = await pdfText(pdfOf(""));
check("a PDF with no text says so rather than reading blank pages", scan.includes("none carrying text") && scan.includes("ask the person"), scan.slice(0, 120));
const asMaterial = await materialText({ title: "brief.pdf", mediaType: "application/pdf" }, `data:application/pdf;base64,${Buffer.from(pdfOf("BT /F1 12 Tf 72 700 Td (From the material path) Tj ET")).toString("base64")}`);
check("a PDF attached as material reaches the specialist as its text", asMaterial.includes("From the material path"), asMaterial.slice(0, 120));
const broken = await materialText({ title: "broken.pdf", mediaType: "application/pdf" }, "data:application/pdf;base64,AAAA");
check("a PDF that cannot be read says so instead of failing the draft", broken.includes("could not be read"), broken.slice(0, 100));

// The older binary workbook, written by the converter's own writer: values,
// a number format, a merge and widths. (That writer drops formulas; the
// reader keeps them from a real .xls, as checked against one by hand.)
const legacy = XLSX.utils.book_new();
const legacySheet = XLSX.utils.aoa_to_sheet([["Client", "Amount"], ["Acme", 1200], ["Globex, Inc", 850.5]]);
legacySheet["B2"]!.z = "#,##0.00";
legacySheet["!merges"] = [{ s: { r: 4, c: 0 }, e: { r: 4, c: 1 } }];
legacySheet["A5"] = { t: "s", v: "Signed off" };
legacySheet["!ref"] = "A1:B5";
legacySheet["!cols"] = [{ wch: 18 }];
XLSX.utils.book_append_sheet(legacy, legacySheet, "Old");
const xls = new Uint8Array(XLSX.write(legacy, { bookType: "xls", type: "buffer" }) as ArrayBuffer);
const oldRendered = await materialText({ title: "budget.xls", mediaType: "application/vnd.ms-excel" }, `data:application/vnd.ms-excel;base64,${Buffer.from(xls).toString("base64")}`);
check(
  "an older binary workbook is read like a modern one: values, format, merge and width",
  oldRendered.includes('Sheet "Old"') && oldRendered.includes('"Globex, Inc",850.5') && oldRendered.includes("Merged: A5:B5") && oldRendered.includes("#,##0.00 at B2") && oldRendered.includes("Column widths: A "),
  oldRendered.slice(0, 200),
);
check("a merged range's value is written once, at its top left", oldRendered.includes("Signed off,\n") || oldRendered.endsWith("Signed off,") || /Signed off,(\n|$)/.test(oldRendered), oldRendered.match(/Signed off[^\n]*/)?.[0] ?? "no merged row");

const parsed = await spreadsheetText(xlsx);
check("a workbook's cells read as text, numbers included", parsed.includes("Acme,1200,2026-09-30"));
const again = await materialText({ title: "x.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AAAA");
check("a spreadsheet that cannot be read says so instead of failing the draft", again.includes("could not be read"), again.slice(0, 80));

let refused: string | null = null;
try {
  await attachMaterial({ projectId: created.projectId, actor: ACTOR, alreadyHeldBytes: 0, files: [{ name: "logo.svg", type: "image/svg+xml", bytes: new Uint8Array([60]) }] });
} catch (cause) {
  refused = cause instanceof HostError ? cause.message : String(cause);
}
check("a type the product cannot keep is refused by name", refused !== null && refused.includes("logo.svg"), refused ?? "accepted");

await attachMaterial({ projectId: created.projectId, actor: ACTOR, alreadyHeldBytes: 0, files: [{ name: "process.csv", type: "text/csv", bytes: new TextEncoder().encode("step,owner\nOnly one,Sam\n") }] });
const after = await projectDetail(created.projectId, ACTOR.principalId);
const versions = after.nodes.filter((node) => node.kind === "source_material" && node.variant === "process.csv");
check("the same file name again is a new version that replaces the old", versions.length === 2 && versions.filter((node) => node.supersededByNodeId === null).length === 1 && versions.some((node) => node.version === 2));
check("the replaced version is what the specialists are handed now", (await stageInputsForSmoke(created.projectId, 1)).includes("Only one,Sam") && !(await stageInputsForSmoke(created.projectId, 1)).includes("Email clients"));

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nMaterial smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
await host.close();
process.exit(failed.length === 0 ? 0 : 1);
