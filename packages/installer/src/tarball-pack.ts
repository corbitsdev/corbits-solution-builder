/**
 * A browser-safe npm-style tarball packer.
 *
 * `apps/web` bundles this package and has neither `node:fs` nor
 * `child_process` (see `workflow-closure.ts`'s own note on the same
 * constraint), so `apps/hub/src/tarball.ts` — which shells out to the
 * system `tar` binary and gzips with `node:zlib` — cannot be reused here.
 * This packer writes ustar headers by hand and gzips with the standard
 * `CompressionStream` API, which both browsers and Bun/Node 18+ implement.
 *
 * The output is a real npm-tarball: every entry lives under `package/`,
 * matching what `extractTarballPackageJSON`
 * (`vendor/interchange/packages/tool-packaging/src/package-json-extract.ts`)
 * and the sidecar's own `strip:1` extractor both expect.
 */

export type TarballFiles = Record<string, Uint8Array>;

const BLOCK_SIZE = 512;
const encoder = new TextEncoder();

function writeAscii(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`ustar field overflow: ${JSON.stringify(value)} exceeds ${String(length)} bytes`);
  header.set(bytes, offset);
}

/** An octal numeric field, NUL-terminated: `length - 1` octal digits then a NUL. */
function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1) throw new Error(`ustar numeric field overflow: ${String(value)} does not fit in ${String(length)} bytes`);
  writeAscii(header, offset, length - 1, digits);
  header[offset + length - 1] = 0;
}

/**
 * ustar splits a path across `name` (100 bytes) and `prefix` (155 bytes),
 * joined by the '/' the split occurred at. Picks the split point closest to
 * the end that keeps both halves in range, matching how GNU/BSD tar itself
 * splits long paths.
 */
function splitUstarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  const segments = path.split("/");
  for (let cut = segments.length - 1; cut > 0; cut--) {
    const prefix = segments.slice(0, cut).join("/");
    const name = segments.slice(cut).join("/");
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long to represent in a ustar header: ${path}`);
}

type UstarTypeflag = "0" | "5";

function ustarHeader(path: string, size: number, typeflag: UstarTypeflag): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const { name, prefix } = splitUstarPath(path);
  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, typeflag === "5" ? 0o755 : 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size); // size
  writeOctal(header, 136, 12, 0); // mtime — deterministic output, no wall clock
  header.fill(0x20, 148, 156); // chksum placeholder: eight ASCII spaces
  header[156] = typeflag.charCodeAt(0);
  // linkname (157..257) stays zero — no symlinks are packed.
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  // uname/gname (265..297, 297..329) stay zero: numeric owner only.
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  writeAscii(header, 345, 155, prefix);

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += header[i]!;
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20; // trailing space, not NUL, per the ustar spec

  return header;
}

function padTo(length: number, block: number): number {
  const remainder = length % block;
  return remainder === 0 ? 0 : block - remainder;
}

/** Concatenates ustar entries (header + padded data) for every file, `package/`-rooted, sorted for deterministic output. */
function buildUstarArchive(files: TarballFiles): Uint8Array {
  const relPaths = Object.keys(files).sort();
  const parts: Uint8Array[] = [];
  const directories = new Set<string>();

  for (const rel of relPaths) {
    if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`refusing to pack ${JSON.stringify(rel)}: entries stay inside package/`);
    }
    const segments = rel.split("/").slice(0, -1);
    let dir = "";
    for (const segment of segments) {
      dir = dir === "" ? segment : `${dir}/${segment}`;
      directories.add(dir);
    }
  }

  const dirEntries = [...directories].sort();
  for (const dir of dirEntries) {
    parts.push(ustarHeader(`package/${dir}/`, 0, "5"));
  }
  for (const rel of relPaths) {
    const bytes = files[rel]!;
    parts.push(ustarHeader(`package/${rel}`, bytes.byteLength, "0"));
    parts.push(bytes);
    const trailing = padTo(bytes.byteLength, BLOCK_SIZE);
    if (trailing > 0) parts.push(new Uint8Array(trailing));
  }
  // Two 512-byte zero blocks close the archive.
  parts.push(new Uint8Array(BLOCK_SIZE * 2));

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return archive;
}

/** Gzips bytes with the standard `CompressionStream` API — no `node:zlib`. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const bufferedBytes = bytes.slice();
  void writer.write(bufferedBytes).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Packs a file tree into real, gzipped npm-tarball bytes: a ustar archive
 * rooted at `package/`, gzipped. Deterministic in every field the format
 * lets us pin (mtime, mode, owner, entry order); gzip's own header carries
 * no timestamp under `CompressionStream`, so repacking the same files
 * yields the same bytes.
 */
export async function packTarballFiles(files: TarballFiles): Promise<Uint8Array> {
  return gzip(buildUstarArchive(files));
}

/**
 * Scoped names flatten to `@scope-tail`, matching
 * `vendor/interchange/packages/tool-packaging/ASSET-LAYOUT.md` and
 * `apps/hub/src/tarball.ts`'s own `tarballFilename` (duplicated here, not
 * imported: that module pulls in `node:child_process` at the top level and
 * cannot be imported from a browser bundle).
 */
export function tarballFilename(name: string, version: string): string {
  return `${name.replace(/\//g, "-")}-${version}.tgz`;
}
