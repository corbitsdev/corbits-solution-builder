/**
 * The vendored `@intx/*` packages a deployed workflow imports, shipped inside
 * the workflow asset as workspace members.
 *
 * A code-sourced workflow package resolves its dependencies through the hub's
 * closure resolver: workspace members from the asset tree, everything else
 * from npm. The published `@intx/workflow` predates the `onTrigger` chat
 * section the lifecycle relies on, so the deployed package must see the
 * vendored revision.
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
import type { ClosureManifest, ClosureManifestEntry } from "./closure-manifest.js";
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
 * The vendored `@intx/*` packages a deployed workflow depends on as
 * `workspace:*`, shipped as workspace members. Every other `@intx/*` package
 * in the manifest resolves from the registry; shipping it as a member too
 * would give the closure two origins for one name.
 */
const VENDORED_MEMBERS: ReadonlySet<string> = new Set(["@intx/workflow"]);

export async function vendoredMemberFiles(
  manifest: ClosureManifest,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of manifest.packages) {
    if (!VENDORED_MEMBERS.has(entry.name)) continue;
    const shortName = entry.name.slice("@intx/".length);
    Object.assign(files, await memberTree(manifest, entry.name, memberDir(shortName), fetchTarball));
  }
  return files;
}

/**
 * `@solutions-builder/app`'s files, as a workspace member: the deck/delivery
 * tools' own imports, the chat section's `routeMessage` action, and
 * everything else `src/` carries. Shipped as source, matching every other
 * environment this package runs consumed-as-source in.
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

/**
 * CL-8719: every stage specialist's `artifacts` tool, as a workspace member
 * the same way `toolsDeckMemberFiles` ships `tools-deck`. `@corbits/artifacts`
 * is not published to the npm registry, so it cannot resolve as a real
 * dependency the way `hono` does -- `scripts/closure-pack.ts`'s
 * `discoverExternalClosure` still packs its real installed directory (from
 * this repo's own `node_modules`, whatever its own install spec), and this
 * ships that same tarball as a `workspace:*` member instead.
 */
/**
 * `@corbits/artifacts` declares every package its sidecar-side code (`sidecar-
 * bundle.ts` -> `tools.ts` -> `artifacts.ts`/`schema.ts`/`db.ts`) actually
 * imports at runtime as `peerDependencies`, never `dependencies` -- reasonably,
 * since its OWN test/mount usage always installs it beside a host that already
 * provides them. The workflow probe materializer that resolves a deployed
 * specialist's dependency closure is a strict per-package store (not a
 * hoisted `node_modules`): it only resolves what a package's OWN
 * `package.json` lists under `dependencies`. This re-declares the ones the
 * sidecar-side code path actually reaches (`@intx/hub-api` and `hono`/
 * `hono-openapi` are peer-only host-side needs of `mount.ts`/`workflow-mount.ts`,
 * never imported here, so they stay peers), in the shipped copy only --
 * `@corbits/artifacts`'s own repository and our installed `node_modules` copy
 * are untouched.
 */
const ARTIFACTS_MISSING_RUNTIME_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@intx/agent": "workspace:*",
  "@intx/types": "workspace:*",
  // `"*"`, not a hardcoded range: `scripts/closure-pack.ts`'s
  // `rewriteDependencies` already rewrites every vendored `@intx/*` member's
  // own `catalog:`-pinned "arktype"/"drizzle-orm"/"postgres" to `"*"` in the
  // packed set (a `workspace:*`/`catalog:` spec is not a real npm range, and
  // the packed set carries exactly one version regardless). The closure
  // resolver rejects two members pinning the same external name at
  // conflicting ranges, so this matches that convention rather than
  // reintroducing a real range here.
  arktype: "*",
  "drizzle-orm": "*",
  postgres: "*",
};

function withPatchedDependencies(packageJson: string, added: Readonly<Record<string, string>>): string {
  const parsed = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  // Moved, not merely added: the closure resolver's cross-member range check
  // reads `peerDependencies` too, so leaving the original peer entry in place
  // (e.g. arktype's real "^2.1.29") conflicts with the "catalog:" range this
  // adds under `dependencies`.
  for (const name of Object.keys(added)) delete parsed.peerDependencies?.[name];
  parsed.dependencies = { ...parsed.dependencies, ...added };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function artifactsMemberFiles(
  manifest: ClosureManifest,
  fetchTarball: ClosureTarballFetcher,
): Promise<Record<string, string>> {
  const dir = "packages/corbits-artifacts";
  const files = await memberTree(manifest, "@corbits/artifacts", dir, fetchTarball);
  const packageJsonPath = `${dir}/package.json`;
  const packageJson = files[packageJsonPath];
  if (packageJson === undefined) {
    throw new Error(`${packageJsonPath} is missing from the packed @corbits/artifacts tarball`);
  }
  files[packageJsonPath] = withPatchedDependencies(packageJson, ARTIFACTS_MISSING_RUNTIME_DEPENDENCIES);
  return files;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One hash over every file, so a changed byte anywhere re-deploys. */
export async function treeDigest(files: Record<string, string>): Promise<string> {
  let input = "";
  for (const path of Object.keys(files).sort()) {
    input += `${path}\0${files[path]!}\0`;
  }
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))));
}
