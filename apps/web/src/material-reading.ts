/**
 * What a specialist is handed for one attached file: the text of what can be
 * read, or a plain note of what cannot. Ported from `apps/hub`'s deleted
 * `source-material.ts` (main) so the browser can extract it itself now that
 * uploads go straight to the artifacts package rather than through the hub.
 *
 * `unpdf`, `exceljs` and `jszip` are loaded with dynamic `import()` inside
 * the branches that need them, so a project that never attaches a PDF, a
 * spreadsheet or a PowerPoint never pays to bundle that reader.
 */
import type ExcelJSNamespace from "exceljs";

export type MaterialInput = { name: string; mediaType: string; bytes: Uint8Array };

/** Characters of one file a prompt carries; the rest is noted as left out. */
const MAX_FILE_CHARS = 40_000;
/** Rows of one sheet a prompt carries. */
const MAX_SHEET_ROWS = 2_000;
/** Formulas one sheet lists before the rest is noted as left out. */
const MAX_SHEET_FORMULAS = 500;
/** Number-format cells one sheet lists before the rest is noted as left out. */
const MAX_FORMAT_CELLS = 200;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";
const PDF_MIME = "application/pdf";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function isText(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

function isXlsx(name: string, mediaType: string): boolean {
  return mediaType === XLSX_MIME || name.toLowerCase().endsWith(".xlsx");
}

function isLegacyXls(name: string, mediaType: string): boolean {
  return mediaType === XLS_MIME || name.toLowerCase().endsWith(".xls");
}

/**
 * The older binary workbook, converted to the modern format so the same
 * renderer serves both. Ported from `apps/hub`'s deleted
 * `source-material.ts` (main), `legacyWorkbookToXlsx`.
 */
async function legacyWorkbookToXlsx(bytes: Uint8Array): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellNF: true, cellStyles: true });
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true }) as ArrayBuffer);
}

function isPdf(name: string, mediaType: string): boolean {
  return mediaType === PDF_MIME || name.toLowerCase().endsWith(".pdf");
}

function isPptx(name: string, mediaType: string): boolean {
  return mediaType === PPTX_MIME || name.toLowerCase().endsWith(".pptx");
}

/**
 * Whether a binary file's reading is text that was read, rather than the
 * note this module writes when nothing could be: every such note is one
 * parenthesised sentence, and every read PDF or PowerPoint opens with its
 * first page or slide.
 */
export function readingHasText(reading: string): boolean {
  const text = reading.trim();
  return text.length > 0 && !(text.startsWith("(") && text.endsWith(")"));
}

/** Never a silent cut: what is left out past the cap is always announced. */
function cap(text: string): string {
  return text.length > MAX_FILE_CHARS
    ? `${text.slice(0, MAX_FILE_CHARS)}\n(${text.length - MAX_FILE_CHARS} more characters not shown)`
    : text;
}

function describe(name: string, mediaType: string, size: number, what: string): string {
  return `(${what} attached: ${name}, ${mediaType || "unknown type"}, ${Math.ceil(size / 1024)} KB. Nothing here reads this kind of file yet; ask what it contains if that matters.)`;
}

function csvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A cell's text as a person would read it: a date as a date, and a merged range's value once, at its top left. */
function cellText(cell: ExcelJSNamespace.Cell): string {
  if (cell.isMerged && cell.master !== cell) return "";
  const value = cell.value;
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace(".000Z", "Z");
  }
  return cell.text ?? "";
}

/** 1 → A, 27 → AA: how a sheet names its columns. */
function columnLetter(index: number): string {
  let name = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(64 + ((n - 1) % 26) + 1) + name;
  return name;
}

/**
 * A workbook as what a workbook is, one block per sheet: its extent, the CSV
 * of its values, and then what CSV has nowhere to carry — merged ranges,
 * column widths where set, every formula, and every number format with the
 * cells that use it. Anything past a cap is noted rather than dropped in
 * silence, so a reader knows the rendering is partial rather than the sheet.
 */
async function spreadsheetText(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const blocks: string[] = [];
  workbook.eachSheet((sheet) => {
    const lines: string[] = [];
    const formulas: string[] = [];
    const formats = new Map<string, string[]>();
    let rows = 0;
    let columns = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      rows += 1;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(csvCell(cellText(cell)));
        columns = Math.max(columns, Number(cell.col));
        const value = cell.value as { formula?: string; sharedFormula?: string } | null;
        if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
          const formula = value.formula ?? `(shared with ${value.sharedFormula})`;
          formulas.push(`${cell.address} =${formula} → ${cellText(cell)}`);
        }
        if (cell.numFmt && cell.numFmt !== "General") {
          const users = formats.get(cell.numFmt) ?? [];
          users.push(cell.address);
          formats.set(cell.numFmt, users);
        }
      });
      if (rows <= MAX_SHEET_ROWS) lines.push(cells.join(","));
    });
    const extent = sheet.dimensions ? String(sheet.dimensions) : "empty";
    const head = `Sheet "${sheet.name}" (${extent}, ${rows} row${rows === 1 ? "" : "s"} × ${columns} column${columns === 1 ? "" : "s"}):`;
    const left = rows > MAX_SHEET_ROWS ? `\n(${rows - MAX_SHEET_ROWS} more rows not shown)` : "";
    const structure: string[] = [];
    const merges = (sheet.model as { merges?: string[] }).merges ?? [];
    if (merges.length > 0) structure.push(`Merged: ${merges.join(", ")}`);
    const widths = sheet.columns
      .map((column, index) => (typeof column.width === "number" ? `${columnLetter(index + 1)} ${column.width}` : null))
      .filter((entry): entry is string => entry !== null);
    if (widths.length > 0) structure.push(`Column widths: ${widths.join(", ")}`);
    if (formulas.length > 0) {
      const shown = formulas.slice(0, MAX_SHEET_FORMULAS);
      const more = formulas.length - shown.length;
      structure.push(`Formulas:\n${shown.join("\n")}${more > 0 ? `\n(${more} more formulas not shown)` : ""}`);
    }
    if (formats.size > 0) {
      structure.push(
        `Number formats: ${[...formats.entries()]
          .map(([format, users]) => {
            const shown = users.slice(0, MAX_FORMAT_CELLS);
            const more = users.length - shown.length;
            return `${format} at ${shown.join(", ")}${more > 0 ? ` (${more} more)` : ""}`;
          })
          .join("; ")}`,
      );
    }
    blocks.push([head, lines.join("\n") + left, ...structure].join("\n"));
  });
  return blocks.join("\n\n");
}

/**
 * A PDF's text, page by page. Only what the file carries as text: a scan has
 * none, and is said to have none rather than read as blank pages.
 */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const { totalPages, text } = await extractText(document, { mergePages: false });
  const pages = text.map((page, index) => ({ number: index + 1, text: page.trim() })).filter((page) => page.text.length > 0);
  if (pages.length === 0) {
    return `(${totalPages} page${totalPages === 1 ? "" : "s"}, none carrying text: a scanned or image-only PDF. Nothing here reads images, so ask what it says if that matters.)`;
  }
  const blocks = pages.map((page) => `Page ${page.number} of ${totalPages}:\n${page.text}`);
  const silent = totalPages - pages.length;
  return `${blocks.join("\n\n")}${silent > 0 ? `\n\n(${silent} page${silent === 1 ? "" : "s"} with no text, not shown)` : ""}`;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text of one XML text run, its entities decoded. */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return XML_ENTITIES[entity] ?? whole;
  });
}

/** A slide part's text as a person reads it: one line per paragraph, runs joined, empty paragraphs dropped. */
export function slideXmlText(xml: string): string {
  const paragraphs = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
  return paragraphs
    .map((paragraph) =>
      [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((run) => decodeXml(run[1] ?? ""))
        .join("")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The slide parts of a PowerPoint file in the order the presentation shows
 * them: `presentation.xml` lists slide ids, each pointing through the
 * presentation's relationships at a part. A file whose list cannot be read
 * falls back to the parts in file-name order, which is the usual order.
 */
async function slidePartsInOrder(zip: { files: Record<string, unknown>; file(name: string): { async(type: "string"): Promise<string> } | null }): Promise<string[]> {
  const byFileName = Object.keys(zip.files)
    .map((name) => ({ name, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((entry) => Number.isFinite(entry.number))
    .sort((a, b) => a.number - b.number)
    .map((entry) => entry.name);
  const presentation = await zip.file("ppt/presentation.xml")?.async("string");
  const relationships = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentation || !relationships) return byFileName;
  const targets = new Map<string, string>();
  for (const relationship of relationships.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(relationship[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(relationship[0])?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `ppt/${target}`);
  }
  const ordered = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((match) => targets.get(match[1] ?? ""))
    .filter((name): name is string => name !== undefined && name in zip.files);
  return ordered.length > 0 ? ordered : byFileName;
}

/**
 * A PowerPoint file's text, slide by slide, in presentation order. Only what
 * the slides carry as text: a picture-only slide is said to have none, and
 * speaker notes are not read.
 */
async function presentationText(bytes: Uint8Array): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const parts = await slidePartsInOrder(zip);
  if (parts.length === 0) return "(A PowerPoint file with no slides.)";
  const slides: string[] = [];
  for (const [index, part] of parts.entries()) {
    const text = slideXmlText(await zip.file(part)!.async("string"));
    if (text.length > 0) slides.push(`Slide ${index + 1} of ${parts.length}:\n${text}`);
  }
  if (slides.length === 0) {
    return `(${parts.length} slide${parts.length === 1 ? "" : "s"}, none carrying text: pictures only. Nothing here reads images, so ask what they show if that matters.)`;
  }
  const silent = parts.length - slides.length;
  return `${slides.join("\n\n")}${silent > 0 ? `\n\n(${silent} slide${silent === 1 ? "" : "s"} with no text, not shown)` : ""}`;
}

/**
 * What can be read of one attached file: text of any kind as it is; a
 * spreadsheet, modern or the older binary kind, as one block per sheet; a
 * PDF as its text, page by page; a PowerPoint file as its slides' text; an
 * image, a Word file, or anything else nothing here reads yet, by name,
 * type and size only — a prompt that claims to have read something it has
 * not is worse than one that says so.
 */
export async function readMaterial(input: MaterialInput): Promise<{ text: string }> {
  const { name, mediaType, bytes } = input;
  if (isText(mediaType)) {
    return { text: cap(new TextDecoder("utf-8").decode(bytes)) };
  }
  if (isXlsx(name, mediaType)) {
    return { text: cap(await spreadsheetText(bytes)) };
  }
  if (isLegacyXls(name, mediaType)) {
    return { text: cap(await spreadsheetText(await legacyWorkbookToXlsx(bytes))) };
  }
  if (isPdf(name, mediaType)) {
    return { text: cap(await pdfText(bytes)) };
  }
  if (isPptx(name, mediaType)) {
    return { text: cap(await presentationText(bytes)) };
  }
  const what = mediaType.startsWith("image/") ? "An image" : "A file";
  return { text: describe(name, mediaType, bytes.byteLength, what) };
}
