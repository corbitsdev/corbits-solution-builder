/**
 * Packs our packages into a `package-registry` hub asset the deploy can
 * resolve a dependency closure from — no network, no published packages,
 * no account anywhere.
 *
 * What goes in:
 *
 *   - `@solutions-builder/app`, packed as-is (`packages/` holds one package
 *     today; splitting the kit is CL-7882, not this).
 *   - Every vendored `@intx/*` package the deployed workflow imports. The
 *     root set is derived from `WORKFLOW_PACKAGE_DEPENDENCIES`
 *     (`packages/solutions-builder/src/workflows/lifecycle-source.ts`) —
 *     the same constant the current source-tree deploy renders against — not
 *     a hand-maintained list. `vendoredClosure` (`apps/hub/src/workflow-closure.ts`,
 *     already used by that deploy path) walks each root's `workspace:*`
 *     dependency graph to the full vendored set.
 *
 * Each package becomes one npm-style tarball under `tarballs/<name>-<version>.tgz`
 * in the asset — the exact shape `AssetRegistrySource`
 * (`vendor/interchange/packages/tool-packaging/src/resolver.ts`) scans for.
 * A packed tarball's `dependencies` field keeps only its `@intx/*`
 * `workspace:*` entries (rewritten to `"*"`, since the asset carries exactly
 * one version of each); every other field — arktype, hono, isomorphic-git,
 * anything not vendored here — is dropped. Those are real npm packages, not
 * ours to vendor, and this issue's asset is single-source (no HTTP fallback,
 * matching `resolveWorkflowClosure`'s asset+tarball arm exactly): a
 * `dependencies` entry the asset cannot serve would fail the closure walk
 * outright rather than silently degrade. Resolving those external
 * dependencies is the mixed-registry map the real deploy wires up (CL-7887);
 * it does not belong to this asset.
 *
 * Idempotent: the packed set's digest is compared against
 * `package-registry.json` already on the asset, and an unchanged digest is a
 * read, not a write. Re-run after any packed package changes (or after
 * `bun run vendor:build`) to refresh it — one command, no sequence to
 * remember.
 *
 * Proof: after pushing, the script drives `AssetRegistrySource` +
 * `createClosureResolver` directly against the asset — the same two calls
 * `resolveWorkflowClosure`'s asset+tarball arm makes
 * (`vendor/interchange/packages/hub-sessions/src/workflow-closure-resolution.ts`)
 * — and resolves `@solutions-builder/app`'s closure, printing the pinned
 * manifest with integrity for every entry. No route, no HTTP, no sidecar: the
 * resolver reads tarballs out of the asset in-process.
 *
 * This script only builds and proves the asset. It does not touch the
 * deploy path (CL-7887) and does not install anything into the running app.
 *
 * Usage: `bun run assets:pack-registry`
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  AssetRegistrySource,
  createClosureResolver,
  parsePin,
} from "@intx/tool-packaging";
import { getToolPackageSourceContentIdentity } from "@intx/types/tool-packages";

import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { install } from "../apps/hub/src/install.js";
import { assets as hubAssets } from "../apps/hub/src/hub-client.js";
import { hub } from "../apps/hub/src/hub-mount.js";
import { databaseDirectory } from "../apps/hub/src/paths.js";
import { vendoredClosure } from "../apps/hub/src/workflow-closure.js";
import { WORKFLOW_PACKAGE_DEPENDENCIES } from "@solutions-builder/app/workflows/lifecycle-source";

const REGISTRY_ASSET_NAME = "solutions-builder-packages";
const VENDOR_PACKAGES_DIR = join(import.meta.dir, "..", "vendor", "interchange", "packages");
const APP_PACKAGE_DIR = join(import.meta.dir, "..", "packages", "solutions-builder");
const INDEX_PATH = "package-registry.json";

type PackedFiles = Record<string, Uint8Array>;

type VendoredManifest = {
  name: string;
  version: string;
  type?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
};

type PackedEntry = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
};

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

/** Only the entries the asset can actually serve: `@intx/*` at `workspace:*`,
 *  rewritten to `"*"` since the asset carries exactly one version of each.
 *  Everything else (arktype, hono, isomorphic-git, ...) is a real npm
 *  package this asset does not vendor — see the file header. */
function intxDependenciesOnly(dependencies: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    if (spec === "workspace:*" && name.startsWith("@intx/")) out[name] = "*";
  }
  return out;
}

function readVendoredManifest(shortName: string): VendoredManifest {
  return JSON.parse(readFileSync(join(VENDOR_PACKAGES_DIR, shortName, "package.json"), "utf8")) as VendoredManifest;
}

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/** The tarball's file tree, rooted at `package/` (the npm-tarball convention
 *  `extractTarballPackageJSON` and the sidecar's `tar.extract({strip:1})`
 *  both expect): a trimmed `package.json` plus every runtime `dist/` file.
 *  Declarations, source maps and tests are left out — nothing here type-checks
 *  or tests the packed bytes; it only evaluates them. */
function vendoredTarballFiles(shortName: string): { manifest: VendoredManifest; files: PackedFiles } {
  const manifest = readVendoredManifest(shortName);
  const trimmed = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    dependencies: intxDependenciesOnly(manifest.dependencies),
  };
  const files: PackedFiles = {
    "package.json": new TextEncoder().encode(`${JSON.stringify(trimmed, null, 2)}\n`),
  };
  const distDir = join(VENDOR_PACKAGES_DIR, shortName, "dist");
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`@intx/${shortName} has no dist/; run \`bun run vendor:build\` before packing the registry asset`);
  }
  const paths: string[] = [];
  walkFiles(distDir, paths);
  for (const full of paths) {
    const rel = relative(distDir, full).split("\\").join("/");
    if (/\.d\.ts$/.test(rel) || /\.map$/.test(rel) || /\.test\.js$/.test(rel) || rel === ".emitted") continue;
    files[`dist/${rel}`] = new Uint8Array(readFileSync(full));
  }
  return { manifest, files };
}

/** `@solutions-builder/app`'s own files, packed as-is: its `src/` tree
 *  (there is no build step — the package is consumed as source), with a
 *  `dependencies` field derived the same way (see `intxDependenciesOnly`)
 *  rather than the empty one the checked-in `package.json` carries today
 *  (everything is hoisted to the workspace root, which a standalone tarball
 *  cannot rely on). */
function appTarballFiles(): { manifest: VendoredManifest; files: PackedFiles } {
  const manifest = JSON.parse(readFileSync(join(APP_PACKAGE_DIR, "package.json"), "utf8")) as VendoredManifest;
  const trimmed = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    dependencies: intxDependenciesOnly(WORKFLOW_PACKAGE_DEPENDENCIES),
  };
  const files: PackedFiles = {
    "package.json": new TextEncoder().encode(`${JSON.stringify(trimmed, null, 2)}\n`),
  };
  const srcDir = join(APP_PACKAGE_DIR, "src");
  const paths: string[] = [];
  walkFiles(srcDir, paths);
  for (const full of paths) {
    const rel = relative(APP_PACKAGE_DIR, full).split("\\").join("/"); // "src/..."
    files[rel] = new Uint8Array(readFileSync(full));
  }
  return { manifest, files };
}

/** Scoped names flatten to `@scope-tail`, per
 *  `vendor/interchange/packages/tool-packaging/ASSET-LAYOUT.md`. */
function tarballFilename(name: string, version: string): string {
  return `${name.replace("/", "-")}-${version}.tgz`;
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
async function packTarball(files: PackedFiles): Promise<Uint8Array> {
  const tmp = await mkdtemp(join(tmpdir(), "sb-pack-"));
  try {
    const root = join(tmp, "package");
    const relPaths = Object.keys(files).sort();
    for (const rel of relPaths) {
      const dest = join(root, rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, files[rel]!);
      await utimes(dest, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
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

async function buildPackedEntries(): Promise<PackedEntry[]> {
  const entries: PackedEntry[] = [];
  for (const shortName of vendoredShortNames()) {
    const { manifest, files } = vendoredTarballFiles(shortName);
    const bytes = await packTarball(files);
    entries.push({ name: manifest.name, version: manifest.version, filename: tarballFilename(manifest.name, manifest.version), bytes });
  }
  const { manifest, files } = appTarballFiles();
  const bytes = await packTarball(files);
  entries.push({ name: manifest.name, version: manifest.version, filename: tarballFilename(manifest.name, manifest.version), bytes });
  entries.sort((a, b) => a.filename.localeCompare(b.filename));
  return entries;
}

/** Our own bookkeeping digest, for the idempotency check only — not the
 *  resolver's integrity, which `@intx/tool-packaging` computes itself (with
 *  `ssri`, a dependency of that package, not this script) when it reads the
 *  tarball back out of the asset. Same SRI shape (`sha512-<base64>`) so the
 *  index reads like the manifest it stands beside. */
function sha512Sri(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function digestEntries(entries: readonly PackedEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.filename);
    hash.update("\0");
    hash.update(sha512Sri(entry.bytes));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function ensureRegistryAssetId(): Promise<string> {
  const existing = await hubAssets.list("package-registry");
  const found = existing.find((asset) => asset.name === REGISTRY_ASSET_NAME);
  if (found) return found.id;
  const created = await hubAssets.create({
    kind: "package-registry",
    name: REGISTRY_ASSET_NAME,
    displayName: "Solutions Builder packages",
  });
  return created.id;
}

async function currentIndexDigest(assetId: string): Promise<string | null> {
  try {
    const bytes = await hub().assetService.readAssetBlob({ assetId, path: INDEX_PATH });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { digest?: unknown };
    return typeof parsed.digest === "string" ? parsed.digest : null;
  } catch {
    return null;
  }
}

/** Pushes the packed set into the asset in one commit, replacing whatever
 *  `tarballs/` held before (so a package dropped from the closure does not
 *  linger as a stale, unreferenced tarball). Skips the write when the digest
 *  already matches — refreshing after a change is this same command, not a
 *  sequence, and re-running with nothing changed is a read. */
async function pushRegistryAsset(
  assetId: string,
  entries: readonly PackedEntry[],
): Promise<{ changed: boolean; commitSha: string }> {
  const digest = digestEntries(entries);
  const existingDigest = await currentIndexDigest(assetId);
  if (existingDigest === digest) return { changed: false, commitSha: "" };

  const files: Record<string, string | Uint8Array> = {};
  for (const entry of entries) files[`tarballs/${entry.filename}`] = entry.bytes;
  files[INDEX_PATH] = `${JSON.stringify(
    {
      generatedBy: "scripts/pack-registry-asset.ts",
      digest,
      packages: entries.map((entry) => ({ name: entry.name, version: entry.version, filename: entry.filename })),
    },
    null,
    2,
  )}\n`;

  const { commitSha } = await hub().assetService.populateAsset({
    assetId,
    ref: "refs/heads/main",
    principal: { kind: "hub" },
    tree: { files, clearPrefix: "tarballs/", message: `Pack ${String(entries.length)} package(s) into ${REGISTRY_ASSET_NAME}` },
  });
  return { changed: true, commitSha };
}

/** The proof: drive `AssetRegistrySource` + `createClosureResolver` directly
 *  against the pushed asset, the same two calls
 *  `resolveWorkflowClosure`'s asset+tarball arm makes. No route, no HTTP. */
async function resolveAndPrintClosure(assetId: string, pin: string): Promise<void> {
  const assetService = hub().assetService;
  const source = new AssetRegistrySource({
    name: REGISTRY_ASSET_NAME,
    assetId,
    readBlob: (path) => assetService.readAssetBlob({ assetId, path }),
    listBlobs: (dir) => assetService.listAssetBlobs({ assetId, dir }),
  });
  const resolver = createClosureResolver({
    registries: new Map([[REGISTRY_ASSET_NAME, source]]),
    defaultRegistry: REGISTRY_ASSET_NAME,
  });

  const manifest = await resolver.resolveClosure([parsePin(pin)]);
  console.log(
    `\nResolved ${pin} from asset "${REGISTRY_ASSET_NAME}" (${assetId}): ${String(manifest.entries.length)} package(s), no network reached.\n`,
  );
  for (const entry of manifest.entries) {
    const identity = getToolPackageSourceContentIdentity(entry.source);
    console.log(`  ${entry.name}@${entry.version}  source=${entry.source.kind}  integrity=${identity}`);
  }
}

async function main(): Promise<void> {
  console.log("Packing @solutions-builder/app and the vendored @intx/* closure...");
  const entries = await buildPackedEntries();
  for (const entry of entries) console.log(`  packed ${entry.filename} (${String(entry.bytes.byteLength)} bytes)`);

  const host = await openDatabase(databaseDirectory());
  await prepareDatabase(host);
  await install();

  const assetId = await ensureRegistryAssetId();
  const { changed, commitSha } = await pushRegistryAsset(assetId, entries);
  console.log(
    changed
      ? `\nPushed ${String(entries.length)} tarball(s) into asset ${assetId} (commit ${commitSha}).`
      : `\nAsset ${assetId} is already at the current digest; nothing to push.`,
  );

  const app = entries.find((entry) => entry.name === "@solutions-builder/app");
  if (!app) throw new Error("@solutions-builder/app was not packed");
  await resolveAndPrintClosure(assetId, `${app.name}@${app.version}`);

  process.exit(0);
}

await main();
