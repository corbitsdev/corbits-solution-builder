/**
 * A zip archive handed over as source material is not kept as itself: it is
 * the files inside it, each attached under its path within the archive. The
 * rules are main's (`apps/hub/src/source-material.ts` there), applied in the
 * browser here since this lane attaches material from the client: folders,
 * what macOS adds when zipping (`__MACOSX/`, `._` resource forks,
 * `.DS_Store`, `Thumbs.db`) and any file of a kind the specialists cannot
 * read are left out; an archive inside an archive is opened too, up to
 * three deep; an archive with nothing keepable, or one that is not a zip,
 * is refused by name.
 */
import JSZip from "jszip";

/** How a zip arrives: the browser's type for it, or the extension when the browser gave none. */
const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "multipart/x-zip"]);
/** Archives inside archives are opened too, this many deep; past that the entry is left out. */
const MAX_ZIP_DEPTH = 3;

/** What a file inside an archive is, by its extension: the kinds `MATERIAL_ACCEPT` lists, with the type `attachMaterial` keys on. */
const KEPT_KINDS = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".html", "text/html"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".doc", "application/msword"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export function isZipArchive(file: { readonly name: string; readonly type: string }): boolean {
  return ZIP_TYPES.has(file.type) || file.name.toLowerCase().endsWith(".zip");
}

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function isJunk(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return path.startsWith("__MACOSX/") || base.startsWith("._") || base === ".DS_Store" || base === "Thumbs.db";
}

/** The refusal `attachMaterial` surfaces: a named archive that gives nothing. */
export class ArchiveRefused extends Error {}

/**
 * The files an archive holds that the specialists can read, each named by
 * its path in the archive, in path order. Throws `ArchiveRefused` for an
 * archive that is not a zip or holds nothing keepable.
 */
export async function filesInZip(archive: File, depth = 1): Promise<File[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await archive.arrayBuffer());
  } catch {
    throw new ArchiveRefused(`${archive.name} could not be read as a zip archive.`);
  }
  const files: File[] = [];
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = entry.name.replace(/^\/+/, "");
    if (isJunk(path)) continue;
    const extension = extensionOf(path);
    if (extension === ".zip") {
      if (depth < MAX_ZIP_DEPTH) {
        const inner = new File([await entry.async("arraybuffer")], path, { type: "application/zip" });
        files.push(...(await filesInZip(inner, depth + 1).catch(() => [])));
      }
      continue;
    }
    const type = KEPT_KINDS.get(extension);
    if (!type) continue;
    files.push(new File([await entry.async("arraybuffer")], path, { type }));
  }
  if (files.length === 0) {
    throw new ArchiveRefused(`${archive.name} holds nothing this can keep. Documents, spreadsheets, and PNG, JPEG, GIF or WebP images are.`);
  }
  return files;
}

/** `files` with every zip archive replaced by the files inside it, in place; anything else is kept as it came. */
export async function expandArchives(files: readonly File[]): Promise<File[]> {
  const expanded: File[] = [];
  for (const file of files) {
    if (isZipArchive(file)) expanded.push(...(await filesInZip(file)));
    else expanded.push(file);
  }
  return expanded;
}
