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
 * in.
 *
 * The bytes come from the static tarballs `scripts/pack-closure-static.ts`
 * writes to `apps/web/public/closure/` (manifest.json plus one `.tgz` per
 * package) rather than a generated TypeScript constant: `install()` must not
 * read the live vendor tree -- apps/web imports this package, and the web
 * bundle has no `node:fs` -- and a build-time snapshot went stale every time
 * a `package.json` changed. The caller fetches the manifest and tarballs
 * (same-origin static files) and hands the bytes in; this module only
 * extracts and reshapes them into asset-tree paths.
 */
import { createHash } from "node:crypto";
import type { ClosureManifest, ClosureManifestEntry } from "./registry-tarballs.js";
import { extractTarballFiles } from "./tarball-extract.js";

/** Where a vendored package lands inside the asset: `packages/intx-<name>`. */
export function memberDir(shortName: string): string {
  return `packages/intx-${shortName}`;
}

/** Fetches one closure tarball's raw bytes, given its manifest filename. */
export type ClosureTarballFetcher = (filename: string) => Promise<Uint8Array>;

function findEntry(manifest: ClosureManifest, name: string): ClosureManifestEntry {
  const entry = manifest.packages.find((pkg) => pkg.name === name);
  if (entry === undefined) {
    throw new Error(`closure manifest is missing ${name}; run \`bun run assets:pack-closure\``);
  }
  return entry;
}

/** Extracts `name`'s tarball and re-keys its files under `dir`. */
async function memberTree(
  manifest: ClosureManifest,
  name: string,
  dir: string,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  const entry = findEntry(manifest, name);
  const extracted = await extractTarballFiles(await fetchTarball(entry.filename));
  const files: Record<string, string> = {};
  for (const [rel, content] of Object.entries(extracted)) files[`${dir}/${rel}`] = content;
  return files;
}

/**
 * Every vendored `@intx/*` package the manifest carries, as workspace
 * members. The manifest already holds the full transitive closure `@intx/
 * workflow` and `@intx/tools-posix` need (`scripts/closure-pack.ts`'s
 * `vendoredShortNames`), so nothing here needs to walk `workspace:*` edges
 * itself -- it just ships whatever the manifest names `@intx/*`.
 */
export async function vendoredMemberFiles(
  manifest: ClosureManifest,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of manifest.packages) {
    if (!entry.name.startsWith("@intx/")) continue;
    const shortName = entry.name.slice("@intx/".length);
    Object.assign(files, await memberTree(manifest, entry.name, memberDir(shortName), fetchTarball));
  }
  return files;
}

/**
 * `@solutions-builder/app`'s files, as a workspace member: the deck/delivery
 * tools' own imports, the gate loop's `admitGate` action, and everything
 * else `src/` carries. Shipped as source, matching every other environment
 * this package runs consumed-as-source in.
 */
export async function appMemberFiles(
  manifest: ClosureManifest,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  return memberTree(manifest, "@solutions-builder/app", "packages/solutions-builder-app", fetchTarball);
}

/** Stage 5's deck tool, as a workspace member: `render_deck`'s own package,
 *  whose `@solutions-builder/app: workspace:*` dependency resolves against
 *  the member `appMemberFiles` ships beside it. */
export async function toolsDeckMemberFiles(
  manifest: ClosureManifest,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  return memberTree(manifest, "@solutions-builder/tools-deck", "packages/tools-deck", fetchTarball);
}

/** Stage 9's delivery-status tool, as a workspace member, the same way
 *  `toolsDeckMemberFiles` ships `tools-deck`. */
export async function toolsDeliveryMemberFiles(
  manifest: ClosureManifest,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  return memberTree(manifest, "@solutions-builder/tools-delivery", "packages/tools-delivery", fetchTarball);
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
