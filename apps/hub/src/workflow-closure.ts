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

function readManifest(shortName: string): PackageManifest {
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

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * The member's files: a trimmed manifest (no scripts, dev dependencies or
 * publish metadata; the `intx-src` condition stays and is simply never
 * selected) and every runtime file under `dist/`. Declarations and source maps
 * are left out; the sidecar evaluates, it does not type-check.
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
  const distDir = join(VENDORED_PACKAGES, shortName, "dist");
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `@intx/${shortName} has no dist/; run \`bun run vendor:build\` before deploying a code-sourced workflow`,
    );
  }
  const paths: string[] = [];
  walk(distDir, paths);
  for (const full of paths) {
    const rel = relative(distDir, full);
    if (/\.d\.ts$/.test(rel) || /\.map$/.test(rel) || /\.test\.js$/.test(rel) || rel === ".emitted") continue;
    files[`${dir}/dist/${rel.split("\\").join("/")}`] = readFileSync(full, "utf8");
  }
  return files;
}

/** Every vendored member the lifecycle needs, keyed by asset path. */
export function closureFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const shortName of vendoredClosure(root)) Object.assign(files, memberFiles(shortName));
  return files;
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
