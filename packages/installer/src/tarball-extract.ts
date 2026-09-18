/**
 * A browser-safe reader for the gzipped ustar tarballs `tarball-pack.ts`
 * writes (and `scripts/closure-pack.ts` packs the workflow closure into):
 * the mirror image of that packer, decoding with the standard
 * `DecompressionStream` API rather than `node:zlib`.
 *
 * Only regular files are read back; directory entries (typeflag `5`) are
 * skipped since the caller reconstructs directories implicitly from paths.
 */

const BLOCK_SIZE = 512;
const decoder = new TextDecoder();

export class TarballExtractError extends Error {}

/** Gunzips bytes with the standard `DecompressionStream` API. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
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

function readAscii(header: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && header[end] !== 0) end++;
  return decoder.decode(header.subarray(offset, end));
}

function readOctal(header: Uint8Array, offset: number, length: number): number {
  const text = readAscii(header, offset, length).trim();
  return text.length === 0 ? 0 : parseInt(text, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * Parses a ustar archive (already decompressed) into `{ path: bytes }`,
 * `package/`-relative -- the npm-tarball convention every packed entry
 * uses. GNU-style long-name/long-link extension headers (typeflag `L`/`K`)
 * are honored since some real npm packages emit them; ustar's own
 * ~255-char split path is read directly off `name`+`prefix`.
 */
function parseUstar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longNameOverride: string | null = null;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break;

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readAscii(header, 345, 155);
    const name = longNameOverride ?? (prefix.length > 0 ? `${prefix}/${readAscii(header, 0, 100)}` : readAscii(header, 0, 100));
    longNameOverride = null;

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new TarballExtractError(`ustar entry ${JSON.stringify(name)} overruns the archive`);
    }
    const data = archive.subarray(dataStart, dataEnd);

    if (typeflag === "L") {
      // GNU long-name extension: the data block is the real name of the
      // entry that immediately follows.
      longNameOverride = decoder.decode(data).replace(/\0+$/, "");
    } else if (typeflag === "0" || typeflag === "\0") {
      files.set(name, data.slice());
    }
    // typeflag "5" (directory) and anything else are skipped.

    const consumed = BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    offset += consumed;
  }
  return files;
}

const PACKAGE_PREFIX = "package/";

/**
 * Extracts a gzipped npm-style tarball into `{ path: text }`, with the
 * leading `package/` root stripped (matching `tar.extract({ strip: 1 })`
 * elsewhere in this repo). Content is decoded as UTF-8: every file the
 * workflow closure ships is source text, never a binary asset.
 */
export async function extractTarballFiles(gzipped: Uint8Array): Promise<Record<string, string>> {
  const archive = await gunzip(gzipped);
  const raw = parseUstar(archive);
  const out: Record<string, string> = {};
  for (const [path, bytes] of raw) {
    if (!path.startsWith(PACKAGE_PREFIX)) continue;
    out[path.slice(PACKAGE_PREFIX.length)] = decoder.decode(bytes);
  }
  return out;
}
