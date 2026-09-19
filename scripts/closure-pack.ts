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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { packTarballFiles, tarballFilename, type TarballFiles } from "./lib/tarball.js";
import { WORKFLOW_PACKAGE_DEPENDENCIES } from "@solutions-builder/app/specialist-source";

export const ROOT_DIR = join(import.meta.dir, "..");
export const VENDOR_PACKAGES_DIR = join(ROOT_DIR, "vendor", "interchange", "packages");
export const APP_PACKAGE_DIR = join(ROOT_DIR, "packages", "solutions-builder");

/**
 * `readManifest`/`distFiles`/`vendoredClosure`/`workspaceCatalog` used to
 * live on `packages/installer/src/workflow-closure.ts` and read a generated
 * embed (`WORKFLOW_CLOSURE_EMBED`) so that browser-bundled module never
 * touched `node:fs`. This script already has real filesystem access -- it
 * is what *produces* the closure's shipped bytes now (CL-8334) -- so it
 * reads `vendor/` directly instead; the browser side reads back the
 * tarballs this script writes rather than a build-time snapshot.
 */

/** A vendored `@intx/<shortName>` package's own `package.json`, parsed. */
export function readManifest(shortName: string): PackageManifest {
  const path = join(VENDOR_PACKAGES_DIR, shortName, "package.json");
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

/** The transitive `workspace:*` closure of `@intx/<root>`, root first. */
export function vendoredClosure(root: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const shortName = queue.shift()!;
    if (seen.has(shortName)) continue;
    seen.add(shortName);
    order.push(shortName);
    const manifest = readManifest(shortName);
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec === "workspace:*" && name.startsWith("@intx/")) queue.push(name.slice("@intx/".length));
    }
  }
  return order;
}

/**
 * A vendored package's runtime `dist/` files, keyed by their path relative
 * to `dist/` (POSIX separators). Declarations, source maps, tests and the
 * build's own `.emitted` marker are left out; the sidecar evaluates, it does
 * not type-check.
 */
export function distFiles(shortName: string): Record<string, string> {
  const distDir = join(VENDOR_PACKAGES_DIR, shortName, "dist");
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`@intx/${shortName} has no dist/; run \`bun run vendor:build\` before packing the workflow closure`);
  }
  const paths: string[] = [];
  walk(distDir, paths);
  const files: Record<string, string> = {};
  for (const full of paths) {
    const rel = relative(distDir, full).split("\\").join("/");
    if (/\.d\.ts$/.test(rel) || /\.map$/.test(rel) || /\.test\.js$/.test(rel) || rel === ".emitted") continue;
    files[rel] = readFileSync(full, "utf8");
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`@intx/${shortName} dist/ has no runtime files to pack`);
  }
  return files;
}

/** The root `catalog` a member's `catalog:` specifier expands against,
 *  shipped in the closure manifest so the browser side needs no copy. */
export function workspaceCatalog(): Record<string, string> {
  const root = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8")) as { catalog?: Record<string, string> };
  return root.catalog ?? {};
}

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
    if (found.has(name) || name.startsWith("@intx/")) continue;
    const dir = resolveExternalPackageDir(name, fromDirs);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
    found.set(name, { name: manifest.name, version: manifest.version, dir });
    for (const depName of Object.keys(manifest.dependencies ?? {})) {
      // A vendored package's own real `package.json` (unlike the trimmed
      // member this same closure ships) still declares its `@intx/*`
      // dependencies untouched. Without this check they re-enter the BFS as
      // "external", get resolved from node_modules, and get packed a
      // second time via `externalTarballFiles`'s raw whole-directory copy
      // (dist, src, tests and all) alongside the correct, curated
      // `vendoredTarballFiles` entry `vendoredShortNames()` already packed
      // -- two tarballs sharing one filename, the raw one overwriting the
      // curated one on disk.
      if (found.has(depName) || depName.startsWith("@intx/")) continue;
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
  /** The workspace root's `catalog` field, so the browser side can expand a
   *  member's `catalog:` specifier without its own copy or `node:fs`. */
  readonly catalog: Record<string, string>;
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
  return { generatedBy, digest: hash.digest("hex"), packages, catalog: workspaceCatalog() };
}
