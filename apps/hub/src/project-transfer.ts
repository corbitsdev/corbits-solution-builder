/**
 * File-save helpers for artifacts a person downloads.
 *
 * Project export/import was deleted as a hard cutover (CL-8492): the ledger
 * it replayed entry-by-entry is going away, and there is no client-side
 * equivalent. What is left here is the desktop shell's own need — its webview
 * cannot download, so the host writes a file to the person's Downloads folder
 * and says where.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Where a saved file lands, unless told otherwise. */
export function exportDirectory(): string {
  return process.env.SOLUTIONS_BUILDER_EXPORT_DIR?.trim() || join(homedir(), "Downloads");
}

/** A file name for an artifact: its title, slugged, with the extension its type implies. */
export function fileNameFor(title: string, mime: string): string {
  const extension =
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ? "pptx"
      : mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ? "xlsx"
        : mime === "application/pdf"
          ? "pdf"
          : mime === "application/gzip"
            ? "tar.gz"
            : (mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]+/g, "").slice(0, 8) || "bin";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "file";
  return `${slug}.${extension}`;
}

/** Writes bytes as a file in the directory, never over one that is already there. */
export async function saveFile(name: string, bytes: Uint8Array, directory: string): Promise<{ path: string; bytes: number }> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let path = join(directory, name);
  for (let n = 2; await Bun.file(path).exists(); n += 1) {
    path = join(directory, `${stem}-${n}${extension}`);
  }
  await Bun.write(path, bytes);
  return { path, bytes: bytes.byteLength };
}
