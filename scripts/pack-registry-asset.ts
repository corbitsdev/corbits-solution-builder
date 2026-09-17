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
 *   - Every *real* npm package that closure (plus `WORKFLOW_PACKAGE_DEPENDENCIES`
 *     itself) actually imports at runtime — `arktype` and its own dependency
 *     graph, `semver`, `@logtape/logtape`, `@logtape/hono`, `hono` — walked the
 *     same way, from each package's own real `package.json` `dependencies`.
 *     This is not optional: our vendored `dist/` is a plain `tsc` emit, not a
 *     bundle, so e.g. `vendor/interchange/packages/agent/dist/default-director.js`
 *     still has a bare `import { type } from "arktype"` in it. Packing only the
 *     `@intx/*` half and dropping this half would resolve cleanly (the
 *     dropped names never reach the walker) while leaving an import a sidecar
 *     would fail on at evaluation time — a resolvable-but-wrong closure is
 *     worse than an unresolvable one. Each real npm package is packed
 *     unmodified, straight from its installed directory (found the same way
 *     `bun install` itself would resolve it — Bun's own module resolution
 *     from the dependent's real location, not a guess at a store path), so
 *     its own `dependencies`/`peerDependencies` stay exactly what npm
 *     published.
 *
 * Each package becomes one npm-style tarball under `tarballs/<name>-<version>.tgz`
 * in the asset — the exact shape `AssetRegistrySource`
 * (`vendor/interchange/packages/tool-packaging/src/resolver.ts`) scans for.
 * A packed *vendored* tarball's `dependencies` field rewrites `workspace:*`
 * and `catalog:` specs to `"*"` (real npm ranges the vendored manifest never
 * uses) since the asset carries exactly one version of each name; everything
 * else in that field is kept verbatim. Real npm packages are packed with
 * their manifests untouched. Since every name any packed manifest declares as
 * a real dependency is itself packed alongside it, the asset is genuinely
 * single-source: a `dependencies` entry the asset cannot serve would fail the
 * closure walk outright rather than silently degrade.
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
 * (`vendor/interchange/packages/hub-sessions/src/workflow-closure-resolution.ts`),
 * with the resolver's internal registry name set to the asset id itself
 * (`args.source.assetId` there), matching that arm exactly rather than a name
 * of this script's own choosing — and resolves `@solutions-builder/app`'s
 * closure, printing the pinned manifest with integrity for every entry. No
 * route, no HTTP, no sidecar: the resolver reads tarballs out of the asset
 * in-process.
 *
 * This script only builds and proves the asset. It does not touch the
 * deploy path (CL-7887) and does not install anything into the running app.
 *
 * Usage: `bun run assets:pack-registry`
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  AssetRegistrySource,
  createClosureResolver,
  parsePin,
} from "@intx/tool-packaging";
import { getToolPackageSourceContentIdentity } from "@intx/types/tool-packages";

import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { install } from "./host-install.js";
import { assets as hubAssets } from "../apps/hub/src/hub-client.js";
import { hub } from "../apps/hub/src/hub-mount.js";
import { databaseDirectory } from "../apps/hub/src/paths.js";
import { packTarballFiles, tarballFilename, tarballIntegrity, type TarballFiles } from "../apps/hub/src/tarball.js";
import { distFiles, readManifest, vendoredClosure } from "../packages/installer/src/workflow-closure.js";
import { WORKFLOW_PACKAGE_DEPENDENCIES } from "@solutions-builder/app/workflows/lifecycle-source";

/** The asset's human-readable name — how it's found and created. Distinct
 *  from the resolver's internal registry name (see `resolveAndPrintClosure`),
 *  which production keys to the asset id, not this. */
const REGISTRY_ASSET_NAME = "solutions-builder-packages";
const ROOT_DIR = join(import.meta.dir, "..");
const VENDOR_PACKAGES_DIR = join(ROOT_DIR, "vendor", "interchange", "packages");
const APP_PACKAGE_DIR = join(ROOT_DIR, "packages", "solutions-builder");
const INDEX_PATH = "package-registry.json";

/** Recursively lists every file under `dir`, depth-first. Lives here rather
 *  than on the installer closure: that module is imported by the web bundle
 *  and cannot walk the live filesystem. */
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

type PackageManifest = {
  name: string;
  version: string;
  type?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
};

type PackedEntry = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
};

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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
 *  `"*"` since the asset carries exactly one version of the name either way.
 *  Anything else (a real npm range on a real npm dependency) is kept as
 *  declared. */
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
 *  (shared with the source-tree path via `distFiles`, not a second walk).
 *  `peerDependencies`/`peerDependenciesMeta` ride through unmodified — the
 *  resolver validates peers by name+range against the closure, not against
 *  this asset specifically. */
function vendoredTarballFiles(shortName: string): { manifest: PackageManifest; files: TarballFiles } {
  const manifest = readManifest(shortName) as PackageManifest;
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    dependencies: rewriteDependencies(manifest.dependencies),
    ...(manifest.peerDependencies !== undefined ? { peerDependencies: manifest.peerDependencies } : {}),
    ...(manifest.peerDependenciesMeta !== undefined ? { peerDependenciesMeta: manifest.peerDependenciesMeta } : {}),
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
 *  than the empty one the checked-in `package.json` carries today (everything
 *  is hoisted to the workspace root, which a standalone tarball cannot rely
 *  on) — `hono` included, not dropped: it is what satisfies `@logtape/hono`'s
 *  non-optional peer requirement once `@intx/log`'s real dependency on
 *  `@logtape/hono` pulls that package into the closure. */
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
 *  the workspace root), not a hand-parsed lockfile or a guessed store path.
 *  Each vendored package keeps its own resolved `node_modules` (bun's
 *  workspace linking), so resolving from the actual declaring package's
 *  directory gets the exact version that package imports at runtime. */
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

/** BFS over real `dependencies` edges only — `peerDependencies` are not
 *  walked, matching the platform's own resolver: a peer is validated against
 *  whatever the closure already contains by a real dependency edge, never
 *  fetched on its own. Seeded from every non-`@intx` entry any vendored
 *  package's *real* manifest declares, plus `WORKFLOW_PACKAGE_DEPENDENCIES`'s
 *  own non-`@intx` entry (`hono`) — nothing hand-listed beyond those two
 *  already-derived sources. */
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

/** A real npm package's installed directory, packed unmodified — its own
 *  `package.json`, `dependencies` and `peerDependencies` exactly as npm
 *  published them. Only its own `node_modules` (its *own* dependencies'
 *  bytes, packed as their own separate tarballs) is excluded. */
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

async function buildPackedEntries(): Promise<PackedEntry[]> {
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

function digestEntries(entries: readonly PackedEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.filename);
    hash.update("\0");
    hash.update(tarballIntegrity(entry.bytes));
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
 *  `resolveWorkflowClosure`'s asset+tarball arm makes. The registry name
 *  handed to both is the asset id itself, matching that arm's own
 *  `const name = args.source.assetId` exactly — production names the
 *  registry after the asset so a resolution error is traceable to it, and a
 *  different name here would print a different diagnostic than production
 *  ever would. No route, no HTTP. */
async function resolveAndPrintClosure(assetId: string, pin: string): Promise<void> {
  const assetService = hub().assetService;
  const registryName = assetId;
  const source = new AssetRegistrySource({
    name: registryName,
    assetId,
    readBlob: (path) => assetService.readAssetBlob({ assetId, path }),
    listBlobs: (dir) => assetService.listAssetBlobs({ assetId, dir }),
  });
  const resolver = createClosureResolver({
    registries: new Map([[registryName, source]]),
    defaultRegistry: registryName,
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
  if (!existsSync(join(VENDOR_PACKAGES_DIR, "workflow", "dist"))) {
    throw new Error("vendored packages have no dist/; run `bun run vendor:build` first");
  }

  console.log("Packing @solutions-builder/app, the vendored @intx/* closure, and the real npm packages it imports...");
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
