/**
 * Packs the shared workflow closure into npm-style tarballs, in memory.
 *
 * `@solutions-builder/app`, every vendored `@intx/*` package the deployed
 * workflow imports, and every real npm dependency that closure actually
 * requires at runtime — the same derivation `scripts/pack-registry-asset.ts`
 * has always used (`WORKFLOW_PACKAGE_DEPENDENCIES` as the honest root set,
 * `vendoredClosure` walking `workspace:*` edges, real `package.json`
 * `dependencies` walked for the npm half). That script and
 * `scripts/pack-closure-static.ts` both build the *same* packed set — one
 * pushes it into a live hub asset for local/dev seeding, the other writes it
 * to static files the web app ships and the installer uploads at install
 * time — so the packing itself lives here, once, imported by both rather
 * than duplicated.
 *
 * Nothing here touches a hub, a database or the network: this module only
 * reads the local `vendor/`, `packages/` and installed `node_modules` trees
 * and returns bytes.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { packTarballFiles, tarballFilename, type TarballFiles } from "../apps/hub/src/tarball.js";
import { distFiles, readManifest, vendoredClosure } from "../packages/installer/src/workflow-closure.js";
import { WORKFLOW_PACKAGE_DEPENDENCIES } from "@solutions-builder/app/workflows/lifecycle-source";

export const ROOT_DIR = join(import.meta.dir, "..");
export const VENDOR_PACKAGES_DIR = join(ROOT_DIR, "vendor", "interchange", "packages");
export const APP_PACKAGE_DIR = join(ROOT_DIR, "packages", "solutions-builder");

export type PackedEntry = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
};

type PackageManifest = {
  name: string;
  version: string;
  type?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
};

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Recursively lists every file under `dir`, depth-first. */
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

// --- derive what to pack: WORKFLOW_PACKAGE_DEPENDENCIES is the honest
// source for what the deployed workflow needs, not a list maintained here. ---

/** The `@intx/*` package names named `workspace:*` in the deployed workflow's
 *  own dependency declaration — the vendored closure's root set. */
function vendoredRoots(): string[] {
  const roots: string[] = [];
  for (const [name, spec] of Object.entries(WORKFLOW_PACKAGE_DEPENDENCIES)) {
    if (spec === "workspace:*" && name.startsWith("@intx/")) roots.push(name.slice("@intx/".length));
  }
  return roots;
}

/** Every vendored `@intx/*` short name the workflow's roots pull in, transitively. */
function vendoredShortNames(): string[] {
  const seen = new Set<string>();
  for (const root of vendoredRoots()) {
    for (const shortName of vendoredClosure(root)) seen.add(shortName);
  }
  return [...seen].sort();
}

/** A `workspace:*`/`catalog:` spec is not a real npm range; rewrite it to
 *  `"*"` since the packed set carries exactly one version of the name
 *  either way. Anything else (a real npm range on a real npm dependency) is
 *  kept as declared. */
function rewriteDependencies(dependencies: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    out[name] = spec === "workspace:*" || spec === "catalog:" ? "*" : spec;
  }
  return out;
}

/** The tarball's file tree, rooted at `package/` (the npm-tarball convention
 *  `extractTarballPackageJSON` and the sidecar's `tar.extract({strip:1})`
 *  both expect): a trimmed `package.json` plus every runtime `dist/` file
 *  (shared with the source-tree path via `distFiles`, not a second walk). */
function vendoredTarballFiles(shortName: string): { manifest: PackageManifest; files: TarballFiles } {
  const manifest = readManifest(shortName) as PackageManifest;
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    dependencies: rewriteDependencies(manifest.dependencies),
    ...(manifest.peerDependencies !== undefined ? { peerDependencies: manifest.peerDependencies } : {}),
    ...(manifest.peerDependenciesMeta !== undefined
      ? { peerDependenciesMeta: manifest.peerDependenciesMeta }
      : {}),
  };
  const files: TarballFiles = { "package.json": encode(`${JSON.stringify(trimmed, null, 2)}\n`) };
  for (const [rel, content] of Object.entries(distFiles(shortName))) {
    files[`dist/${rel}`] = encode(content);
  }
  return { manifest, files };
}

/** `@solutions-builder/app`'s own files, packed as-is: its `src/` tree
 *  (there is no build step — the package is consumed as source), with a
 *  `dependencies` field derived from `WORKFLOW_PACKAGE_DEPENDENCIES` rather
 *  than the empty one the checked-in `package.json` carries today. */
function appTarballFiles(): { manifest: PackageManifest; files: TarballFiles } {
  const manifest = JSON.parse(readFileSync(join(APP_PACKAGE_DIR, "package.json"), "utf8")) as PackageManifest;
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    dependencies: rewriteDependencies(WORKFLOW_PACKAGE_DEPENDENCIES),
  };
  const files: TarballFiles = { "package.json": encode(`${JSON.stringify(trimmed, null, 2)}\n`) };
  const srcDir = join(APP_PACKAGE_DIR, "src");
  const paths: string[] = [];
  walk(srcDir, paths);
  for (const full of paths) {
    const rel = relative(APP_PACKAGE_DIR, full).split("\\").join("/"); // "src/..."
    files[rel] = new Uint8Array(readFileSync(full));
  }
  return { manifest, files };
}

// --- external (real npm) packages: found by real module resolution, not a
// guess at where a package manager happens to store them, then packed
// byte-for-byte from their installed directory. ---

type ExternalPackage = { readonly name: string; readonly version: string; readonly dir: string };

/** Resolves `name`'s real installed directory the way `bun install` itself
 *  would: real module resolution rooted at a real dependent (falling back to
 *  the workspace root), not a hand-parsed lockfile or a guessed store path. */
function resolveExternalPackageDir(name: string, fromDirs: readonly string[]): string {
  for (const dir of fromDirs) {
    try {
      return dirname(Bun.resolveSync(`${name}/package.json`, dir));
    } catch {
      // Not resolvable from this root; try the next.
    }
  }
  throw new Error(`could not resolve installed package "${name}" from: ${fromDirs.join(", ")}`);
}

/** BFS over real `dependencies` edges only — matching the platform's own
 *  resolver: a peer is validated against whatever the closure already
 *  contains by a real dependency edge, never fetched on its own. */
function discoverExternalClosure(): ExternalPackage[] {
  const found = new Map<string, ExternalPackage>();
  const queue: { name: string; fromDirs: string[] }[] = [];

  for (const shortName of vendoredShortNames()) {
    const manifest = readManifest(shortName) as PackageManifest;
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith("@intx/")) continue;
      queue.push({ name, fromDirs: [join(VENDOR_PACKAGES_DIR, shortName), ROOT_DIR] });
    }
  }
  for (const name of Object.keys(WORKFLOW_PACKAGE_DEPENDENCIES)) {
    if (name.startsWith("@intx/")) continue;
    queue.push({ name, fromDirs: [ROOT_DIR] });
  }

  while (queue.length > 0) {
    const { name, fromDirs } = queue.shift()!;
    if (found.has(name)) continue;
    const dir = resolveExternalPackageDir(name, fromDirs);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
    found.set(name, { name: manifest.name, version: manifest.version, dir });
    for (const depName of Object.keys(manifest.dependencies ?? {})) {
      if (found.has(depName)) continue;
      queue.push({ name: depName, fromDirs: [dir, ROOT_DIR] });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A real npm package's installed directory, packed unmodified. Only its own
 *  `node_modules` (its *own* dependencies' bytes, packed as their own
 *  separate tarballs) is excluded. */
function externalTarballFiles(pkg: ExternalPackage): TarballFiles {
  const paths: string[] = [];
  walk(pkg.dir, paths);
  const files: TarballFiles = {};
  for (const full of paths) {
    const rel = relative(pkg.dir, full).split("\\").join("/");
    if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;
    files[rel] = new Uint8Array(readFileSync(full));
  }
  return files;
}

async function pack(name: string, version: string, files: TarballFiles): Promise<PackedEntry> {
  const bytes = await packTarballFiles(files);
  return { name, version, filename: tarballFilename(name, version), bytes };
}

/** The full packed set: the vendored `@intx/*` closure, `@solutions-builder/app`,
 *  and every real npm package that closure imports at runtime. Sorted by
 *  filename so callers get a stable order. */
export async function buildPackedEntries(): Promise<PackedEntry[]> {
  const entries: PackedEntry[] = [];
  for (const shortName of vendoredShortNames()) {
    const { manifest, files } = vendoredTarballFiles(shortName);
    entries.push(await pack(manifest.name, manifest.version, files));
  }
  const app = appTarballFiles();
  entries.push(await pack(app.manifest.name, app.manifest.version, app.files));
  for (const external of discoverExternalClosure()) {
    entries.push(await pack(external.name, external.version, externalTarballFiles(external)));
  }
  entries.sort((a, b) => a.filename.localeCompare(b.filename));
  return entries;
}

// --- the static manifest: name/version/sha256 per tarball, so the
// install-time step (`packages/installer/src/registry-tarballs.ts`) knows
// what to upload without re-reading the vendor tree itself. ---

export type ClosureManifestEntry = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
};

export type ClosureManifest = {
  readonly generatedBy: string;
  readonly digest: string;
  readonly packages: readonly ClosureManifestEntry[];
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One manifest entry per packed tarball, identified by its own content's sha256. */
export function manifestEntry(entry: PackedEntry): ClosureManifestEntry {
  return { name: entry.name, version: entry.version, filename: entry.filename, sha256: sha256Hex(entry.bytes) };
}

/** The manifest for a packed set: one entry per tarball, sorted by filename,
 *  plus a digest over every entry's filename+sha256 so a single changed
 *  byte anywhere changes the manifest's own digest too. Pure: takes already
 *  packed entries, touches no filesystem. */
export function buildManifest(generatedBy: string, entries: readonly PackedEntry[]): ClosureManifest {
  const packages = entries.map(manifestEntry).sort((a, b) => a.filename.localeCompare(b.filename));
  const hash = createHash("sha256");
  for (const pkg of packages) {
    hash.update(pkg.filename);
    hash.update("\0");
    hash.update(pkg.sha256);
    hash.update("\0");
  }
  return { generatedBy, digest: hash.digest("hex"), packages };
}
