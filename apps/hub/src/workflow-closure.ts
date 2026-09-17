/**
 * The vendored `@intx/*` packages a deployed workflow imports, shipped inside
 * the workflow asset as workspace members.
 *
 * A code-sourced workflow package resolves its dependencies through the hub's
 * closure resolver: workspace members from the asset tree, everything else
 * from npm. The published `@intx/workflow` predates the loop signal relay the
 * lifecycle relies on, so the deployed package must see the vendored revision.
 * Carrying that revision's `dist/` as members of the asset is the one path
 * that needs no registry plumbing: the resolver already walks members, and the
 * sidecar lays a member out from the same git pack the workflow itself arrives
 * in. The cost is a copy of about a megabyte per lifecycle asset.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const VENDORED_PACKAGES = join(import.meta.dir, "..", "..", "..", "vendor", "interchange", "packages");
const ROOT_PACKAGE_JSON = join(import.meta.dir, "..", "..", "..", "package.json");
const SOLUTIONS_BUILDER_APP_DIR = join(import.meta.dir, "..", "..", "..", "packages", "solutions-builder");
const TOOLS_DECK_DIR = join(import.meta.dir, "..", "..", "..", "packages", "tools-deck");
const TOOLS_DELIVERY_DIR = join(import.meta.dir, "..", "..", "..", "packages", "tools-delivery");

/** Where a vendored package lands inside the asset: `packages/intx-<name>`. */
export function memberDir(shortName: string): string {
  return `packages/intx-${shortName}`;
}

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  exports?: unknown;
  type?: string;
  [key: string]: unknown;
};

/** A vendored package's own `package.json`, parsed. Exported so callers that
 *  need more than the trimmed shape `memberFiles` produces — the registry-asset
 *  packer reads real `dependencies`/`peerDependencies` off it — read the same
 *  file through the same path rather than a second copy of this join. */
export function readManifest(shortName: string): PackageManifest {
  return JSON.parse(readFileSync(join(VENDORED_PACKAGES, shortName, "package.json"), "utf8")) as PackageManifest;
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
 * The root `catalog` a member's `catalog:` specifier expands against. Taken
 * from this repository's own catalog, which mirrors the vendored revision's.
 */
export function workspaceCatalog(): Record<string, string> {
  const root = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")) as { catalog?: Record<string, string> };
  return root.catalog ?? {};
}

/** Recursively lists every file under `dir`, depth-first. Exported so any
 *  caller collecting a directory's files (a workspace member, a repacked
 *  tarball) walks it the same way rather than each writing its own. */
export function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * A vendored package's runtime `dist/` files, keyed by their path relative to
 * `dist/` (POSIX separators). Declarations, source maps and tests are left
 * out; the sidecar evaluates, it does not type-check.
 */
export function distFiles(shortName: string): Record<string, string> {
  const distDir = join(VENDORED_PACKAGES, shortName, "dist");
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `@intx/${shortName} has no dist/; run \`bun run vendor:build\` before deploying a code-sourced workflow`,
    );
  }
  const paths: string[] = [];
  walk(distDir, paths);
  const files: Record<string, string> = {};
  for (const full of paths) {
    const rel = relative(distDir, full);
    if (/\.d\.ts$/.test(rel) || /\.map$/.test(rel) || /\.test\.js$/.test(rel) || rel === ".emitted") continue;
    files[rel.split("\\").join("/")] = readFileSync(full, "utf8");
  }
  return files;
}

/**
 * The member's files: a trimmed manifest (no scripts, dev dependencies or
 * publish metadata; the `intx-src` condition stays and is simply never
 * selected) and every runtime file under `dist/`.
 */
export function memberFiles(shortName: string): Record<string, string> {
  const manifest = readManifest(shortName);
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    ...(manifest.dependencies !== undefined ? { dependencies: manifest.dependencies } : {}),
    ...(manifest.peerDependencies !== undefined ? { peerDependencies: manifest.peerDependencies } : {}),
    ...(manifest.peerDependenciesMeta !== undefined
      ? { peerDependenciesMeta: manifest.peerDependenciesMeta }
      : {}),
  };
  const dir = memberDir(shortName);
  const files: Record<string, string> = {
    [`${dir}/package.json`]: `${JSON.stringify(trimmed, null, 2)}\n`,
  };
  for (const [rel, content] of Object.entries(distFiles(shortName))) {
    files[`${dir}/dist/${rel}`] = content;
  }
  return files;
}

/** Every vendored member the lifecycle needs, keyed by asset path. */
export function closureFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const shortName of vendoredClosure(root)) Object.assign(files, memberFiles(shortName));
  return files;
}

/**
 * `@solutions-builder/app`'s pure, tool-imported modules, shipped as one
 * member so `@solutions-builder/tools-deck` and `@solutions-builder/tools-delivery`
 * — both carried by the deployed workflow — resolve `@solutions-builder/app/deck`
 * and `@solutions-builder/app/delivery` in the sidecar the same way they
 * resolve them in this repo. Only these modules ride along: each is the one
 * the corresponding tool imports, and neither has a relative import of its
 * own (only the npm packages `pptxgenjs` and `arktype`), so shipping them
 * alone avoids dragging the rest of the app package — its host-only modules
 * and their host-only dependencies — into an asset that never runs them.
 * Unlike the vendored `@intx/*` members, this ships as TypeScript source:
 * the package is consumed as source everywhere in this repo (see
 * `scripts/pack-registry-asset.ts`'s `appTarballFiles`), so there is no
 * `dist/` to copy.
 */
export function deckAppMemberFiles(): Record<string, string> {
  const dir = "packages/solutions-builder-app";
  const manifest = {
    name: "@solutions-builder/app",
    version: "0.1.0",
    type: "module",
    exports: { "./*": "./src/*.ts" },
    dependencies: { pptxgenjs: "4", arktype: "catalog:" },
  };
  return {
    [`${dir}/package.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
    [`${dir}/src/deck.ts`]: readFileSync(join(SOLUTIONS_BUILDER_APP_DIR, "src", "deck.ts"), "utf8"),
    [`${dir}/src/delivery.ts`]: readFileSync(join(SOLUTIONS_BUILDER_APP_DIR, "src", "delivery.ts"), "utf8"),
  };
}

/**
 * `@solutions-builder/tools-deck`'s own files: the package stage 5's
 * specialist imports for `render_deck`. Shipped as source for the same
 * reason `deckAppMemberFiles` is: this family of packages has no build
 * step. Its own `package.json` rides along unmodified — its
 * `@solutions-builder/app: workspace:*` dependency resolves against the
 * member `deckAppMemberFiles` ships beside it, and `pptxgenjs` resolves
 * from npm like `hono` already does for the lifecycle package itself.
 */
function toolsMemberFiles(name: string, packageDir: string): Record<string, string> {
  const dir = `packages/${name}`;
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as PackageManifest;
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    ...(manifest.dependencies !== undefined ? { dependencies: manifest.dependencies } : {}),
  };
  const files: Record<string, string> = { [`${dir}/package.json`]: `${JSON.stringify(trimmed, null, 2)}\n` };
  const paths: string[] = [];
  walk(join(packageDir, "src"), paths);
  for (const full of paths) {
    const rel = relative(packageDir, full).split("\\").join("/");
    files[`${dir}/${rel}`] = readFileSync(full, "utf8");
  }
  return files;
}

export function toolsDeckMemberFiles(): Record<string, string> {
  return toolsMemberFiles("tools-deck", TOOLS_DECK_DIR);
}

/**
 * `@solutions-builder/tools-delivery`'s own files: the package a stage 9
 * decision-queue step imports for `delivery_status`, shipped the same way
 * `toolsDeckMemberFiles` ships `tools-deck` — as source, its own
 * `package.json` unmodified, `@solutions-builder/app` resolving against the
 * member `deckAppMemberFiles`-style copy shipped beside it.
 */
export function toolsDeliveryMemberFiles(): Record<string, string> {
  return toolsMemberFiles("tools-delivery", TOOLS_DELIVERY_DIR);
}

/** One hash over every file, so a changed byte anywhere re-deploys. */
export function treeDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files[path]!);
    hash.update("\0");
  }
  return hash.digest("hex");
}
