/**
 * What the person handed over with the problem: a spreadsheet, a document,
 * an image. It is theirs and it is the ground truth about their situation, so
 * it is kept as artifact versions like everything else the product records —
 * one `source_material` node per file, the file's own type, the bytes as the
 * content — and every stage's specialist is handed what can be read of it.
 *
 * What can be read: text of any kind as it is; a spreadsheet, modern or the
 * older binary kind, as one block per sheet — its values as CSV, then its
 * merges, widths, formulas and number formats; a PDF as its text, page by page; an image or a Word file by name
 * and size only, since nothing here reads those yet, and a prompt that
 * pretends to have read them is worse than one that says it has not.
 */
import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";
import { HostError } from "./errors.js";
import { writeArtifact } from "./projects.js";
import { activeRun } from "./runs.js";
import { MATERIAL_KIND } from "@solutions-builder/app/artifacts";

export { MATERIAL_KIND };

/** Bytes one file may be, the artifact store's own upload ceiling. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * What can be attached, by extension and type — the artifact store's gallery
 * policy (`ARTIFACT_UPLOAD_POLICY` in `@corbits/artifacts`), kept here in the
 * same words so the answer is the same on both sides. SVG is deliberately
 * absent: it can carry script and is served back on the app's origin.
 */
const ACCEPTED = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".doc", "application/msword"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
const ACCEPTED_TYPES = new Set(ACCEPTED.values());

/** The type to trust: the declared one when it is known, else the extension's, else nothing. */
function effectiveMime(name: string, declared: string): string {
  if (ACCEPTED_TYPES.has(declared)) return declared;
  const lower = name.toLowerCase();
  for (const [extension, mime] of ACCEPTED) if (lower.endsWith(extension)) return mime;
  return "";
}
/** Bytes one project may hold as material, all files together. */
export const MAX_MATERIAL_TOTAL_BYTES = 50 * 1024 * 1024;
/** Characters of one file a prompt carries; the rest is noted as left out. */
const MAX_FILE_CHARS = 40_000;
/** Rows of one sheet a prompt carries. */
const MAX_SHEET_ROWS = 2_000;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";
const PDF = "application/pdf";

export type IncomingFile = { name: string; type: string; bytes: Uint8Array };

function isText(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Decodes a `data:` URL written by `dataUrl`, or null for anything else. */
export function bytesOf(content: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(content);
  return match ? { mime: match[1]!, bytes: new Uint8Array(Buffer.from(match[2]!, "base64")) } : null;
}

/** Accepts the files, refusing a type the product cannot keep or a size it will not. */
export async function attachMaterial(args: {
  projectId: string;
  actor: { principalId: string };
  files: IncomingFile[];
  alreadyHeldBytes: number;
}): Promise<{ nodeId: string; name: string; mediaType: string; sizeBytes: number }[]> {
  if (args.files.length === 0) throw new HostError("validation_failed", "No files were attached.");
  let total = args.alreadyHeldBytes;
  const run = await activeRun(args.projectId);
  const written: { nodeId: string; name: string; mediaType: string; sizeBytes: number }[] = [];
  for (const file of args.files) {
    const mime = effectiveMime(file.name, file.type);
    if (!ACCEPTED_TYPES.has(mime)) {
      throw new HostError(
        "validation_failed",
        `${file.name} is not a kind of file this can keep. Documents, spreadsheets, and PNG, JPEG, GIF or WebP images are.`,
      );
    }
    if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new HostError("validation_failed", `${file.name} is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
    }
    total += file.bytes.byteLength;
    if (total > MAX_MATERIAL_TOTAL_BYTES) {
      throw new HostError(
        "validation_failed",
        `Adding ${file.name} would put the project's material past ${MAX_MATERIAL_TOTAL_BYTES / (1024 * 1024)} MB.`,
      );
    }
    const content = isText(mime) ? new TextDecoder("utf-8").decode(file.bytes) : dataUrl(mime, file.bytes);
    const node = await writeArtifact(
      {
        projectId: args.projectId,
        kind: MATERIAL_KIND,
        // One row per file name: the same name again is a new version of it.
        variant: file.name,
        title: file.name,
        content,
        mediaType: mime,
        sourceVersionIds: [],
        provenance: { producer: "human", ...(run ? { runId: run.id } : {}) },
      },
      args.actor,
    );
    written.push({ nodeId: node.nodeId, name: file.name, mediaType: mime, sizeBytes: file.bytes.byteLength });
  }
  return written;
}

function csvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A cell's text as a person would read it: a date as a date, not as the runtime prints one; a merged range's value once, at its top left. */
function cellText(cell: ExcelJS.Cell): string {
  if (cell.isMerged && cell.master !== cell) return "";
  const value = cell.value;
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace(".000Z", "Z");
  }
  return cell.text ?? "";
}

/** Formulas and number formats one sheet lists before the rest is noted as left out. */
const MAX_SHEET_FORMULAS = 500;
const MAX_FORMAT_CELLS = 200;

/**
 * A workbook as what a workbook is, one block per sheet: its extent, the CSV
 * of its values, and then what CSV has nowhere to carry — merged ranges,
 * column widths where set, every formula, and every number format with the
 * cells that use it. Anything past a cap is noted rather than dropped in
 * silence, so a reader knows the rendering is partial rather than the sheet.
 */
export async function spreadsheetText(bytes: Uint8Array): Promise<string> {
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
        const value = cell.value as { formula?: string; sharedFormula?: string; result?: unknown } | null;
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
 * The older binary workbook, converted to the modern format so one renderer
 * serves both. The converter reads values, formulas, number formats, merges
 * and column widths from the binary form.
 */
export function legacyWorkbookToXlsx(bytes: Uint8Array): Uint8Array {
  const workbook = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellNF: true, cellStyles: true });
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true }) as ArrayBuffer);
}

/** 1 → A, 27 → AA: how a sheet names its columns. */
function columnLetter(index: number): string {
  let name = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(64 + ((n - 1) % 26) + 1) + name;
  return name;
}

/**
 * A PDF's text, page by page. Only what the file carries as text: a scan has
 * none, and is said to have none rather than read as blank pages.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  // Quiet: a PDF with a broken cross-reference table makes the reader say so
  // on the console, which is the host log, and it copes with it anyway.
  const document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const { totalPages, text } = await extractText(document, { mergePages: false });
  const pages = text.map((page, index) => ({ number: index + 1, text: page.trim() })).filter((page) => page.text.length > 0);
  if (pages.length === 0) {
    return `(${totalPages} page${totalPages === 1 ? "" : "s"}, none carrying text: a scanned or image-only PDF. Nothing here reads images, so ask the person what it says if that matters.)`;
  }
  const blocks = pages.map((page) => `Page ${page.number} of ${totalPages}:\n${page.text}`);
  const silent = totalPages - pages.length;
  return `${blocks.join("\n\n")}${silent > 0 ? `\n\n(${silent} page${silent === 1 ? "" : "s"} with no text, not shown)` : ""}`;
}

function describe(name: string, mime: string, size: number, what: string): string {
  return `(${what} the person attached: ${name}, ${mime}, ${Math.ceil(size / 1024)} KB.)`;
}

/**
 * What a specialist is handed for one piece of material: the text of what
 * can be read, or a plain note of what cannot. Never a claim to have read
 * something nothing here reads.
 */
export async function materialText(node: { title: string; mediaType: string }, content: string): Promise<string> {
  const cap = (text: string) =>
    text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n(${text.length - MAX_FILE_CHARS} more characters not shown)` : text;
  if (isText(node.mediaType)) return cap(content);
  const stored = bytesOf(content);
  if (!stored) return describe(node.title, node.mediaType, content.length, "A file");
  if (node.mediaType === XLSX_MIME || node.mediaType === XLS_MIME) {
    try {
      return cap(await spreadsheetText(node.mediaType === XLS_MIME ? legacyWorkbookToXlsx(stored.bytes) : stored.bytes));
    } catch (cause) {
      return `${describe(node.title, node.mediaType, stored.bytes.byteLength, "A spreadsheet")} It could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  if (node.mediaType === PDF) {
    try {
      return cap(await pdfText(stored.bytes));
    } catch (cause) {
      return `${describe(node.title, node.mediaType, stored.bytes.byteLength, "A PDF")} It could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  if (node.mediaType.startsWith("image/")) {
    return `${describe(node.title, node.mediaType, stored.bytes.byteLength, "An image")} It is kept with the project; nothing here reads images yet, so ask the person what it shows if that matters.`;
  }
  return `${describe(node.title, node.mediaType, stored.bytes.byteLength, "A file")} Nothing here reads this kind of file yet; ask the person about what it contains if that matters.`;
}
