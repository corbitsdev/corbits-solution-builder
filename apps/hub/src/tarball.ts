/**
 * The client's half of the tarball deploy source: pack a package into real
 * npm-tarball bytes and name it the way the hub's package-registry asset
 * expects. The format is the only thing built here — closure resolution,
 * version pinning and integrity are the platform's, untouched. The hub
 * stores pushed bytes verbatim, so bytes packed here are the bytes a deploy
 * resolves.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export type TarballFiles = Record<string, Uint8Array>;

/**
 * Scoped names flatten to `@scope-tail`, per
 * `vendor/interchange/packages/tool-packaging/ASSET-LAYOUT.md`.
 */
export function tarballFilename(name: string, version: string): string {
  return `${name.replace(/\//g, "-")}-${version}.tgz`;
}

/**
 * Integrity over tarball bytes in the same `sha512-<base64>` SRI shape the
 * hub returns on push, so a client can check the hub stored exactly what was
 * sent without trusting the round trip.
 */
export function tarballIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** A fixed mtime for every packed file, so the archive depends only on file
 *  contents and names — never on the wall clock a temp directory happened to
 *  be built at. Without this, re-running with nothing changed still rewrites
 *  the asset, and two people packing the same tree get different bytes. */
const DETERMINISTIC_MTIME = new Date(0);

/** Real npm-tarball bytes: `package/` at the tar root, byte-for-byte the same
 *  across runs given the same file contents. Shells out to the system `tar`
 *  for the archive layout rather than inventing one — but pins every entry's
 *  mtime, writes entries in a fixed sorted order (not filesystem readdir
 *  order, which is not guaranteed stable), and gzips the tar bytes with
 *  Node's `zlib` (deterministic; the system `gzip` embeds a source-file
 *  timestamp `tar czf` cannot suppress). The format is the only thing built
 *  here; the resolver, pinning and integrity are the platform's, untouched. */
export async function packTarballFiles(files: TarballFiles): Promise<Uint8Array> {
  const relPaths = Object.keys(files).sort();
  for (const rel of relPaths) {
    if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`refusing to pack ${JSON.stringify(rel)}: entries stay inside package/`);
    }
  }
  const tmp = await mkdtemp(join(tmpdir(), "sb-pack-"));
  try {
    const root = join(tmp, "package");
    for (const rel of relPaths) {
      const dest = join(root, rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, files[rel]!);
      await utimes(dest, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
    }
    // Pin the ancestor directories too: GNU tar stores leading directory
    // entries (bsdtar does not), and an unpinned one leaks the temp
    // directory's creation time into the archive.
    const ancestors = new Set([root]);
    for (const rel of relPaths) {
      let dir = root;
      for (const part of rel.split("/").slice(0, -1)) {
        dir = join(dir, part);
        ancestors.add(dir);
      }
    }
    for (const dir of ancestors) {
      await utimes(dir, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
    }
    const outTar = join(tmp, "out.tar");
    const result = spawnSync("tar", [
      "--format=ustar",
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "-cf",
      outTar,
      "-C",
      tmp,
      ...relPaths.map((rel) => `package/${rel}`),
    ]);
    if (result.status !== 0) {
      throw new Error(`tar failed (${String(result.status)}): ${result.stderr?.toString() ?? ""}`);
    }
    const tarBytes = await readFile(outTar);
    return new Uint8Array(gzipSync(tarBytes, { level: 9 }));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Packs a package directory on disk: every regular file becomes a `package/`
 * entry keyed by its path relative to the directory. Symlinks and other
 * non-regular files are skipped — a pushed tarball must be self-contained,
 * and a link the sidecar cannot resolve at extract time would break the
 * deploy it sources.
 */
export async function packDirectory(dir: string): Promise<Uint8Array> {
  const files: TarballFiles = {};
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (entry.isFile()) {
        files[relPath] = await readFile(join(dir, relPath));
      }
    }
  }
  await walk("");
  return packTarballFiles(files);
}

/**
 * The wire half of the push: PUTs already-packed bytes at the hub's tarball
 * route and checks the hub stored exactly what was sent. The hub computes
 * integrity from the request bytes and stores those bytes verbatim, so a
 * matching value means the bytes a later deploy resolves are these bytes.
 * The transport is injected so tests can prove the contract without a hub;
 * `hub-client.ts` binds the real one.
 */
export type TarballPushTransport = {
  putBytes(path: string, bytes: Uint8Array): Promise<{ commit: string; integrity: string }>;
};

export function tarballPushPath(assetId: string, filename: string): string {
  return `/assets/${assetId}/tarballs/${filename}`;
}

export async function pushTarball(
  transport: TarballPushTransport,
  args: { assetId: string; filename: string; bytes: Uint8Array },
): Promise<{ commit: string; integrity: string }> {
  const sent = tarballIntegrity(args.bytes);
  const result = await transport.putBytes(tarballPushPath(args.assetId, args.filename), args.bytes);
  if (result.integrity !== sent) {
    throw new Error(
      `the hub stored different bytes than were pushed for ${args.filename}: ` +
        `sent ${sent}, the hub reports ${result.integrity}`,
    );
  }
  return result;
}
