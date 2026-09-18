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
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  AssetRegistrySource,
  createClosureResolver,
  parsePin,
} from "@intx/tool-packaging";
import { getToolPackageSourceContentIdentity } from "@intx/types/tool-packages";

import { install as installerInstall } from "@solutions-builder/installer";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { rerankCatalogProviders } from "../apps/hub/src/catalog.js";
import {
  assets as hubAssets,
  forgetWorkspace as hubClientForgetWorkspace,
  hubTransport,
  resolveWorkspace,
  signInEmail,
  signUpEmail,
} from "../apps/hub/src/hub-client.js";
import { canPlaceSidecars, hub } from "../apps/hub/src/hub-mount.js";
import { databaseDirectory } from "../apps/hub/src/paths.js";
import { tarballIntegrity } from "./lib/tarball.js";
import { adoptLegacyWorkspaceOnce } from "../apps/hub/src/workspace-boot.js";
import { buildPackedEntries, VENDOR_PACKAGES_DIR, type PackedEntry } from "./closure-pack.js";

/** Signs in (or up) a script account and drives the installer through the
 *  hub's own transport, the same way `host-install.ts` did for smokes before
 *  it was deleted (CL-8344) — this asset-packing script still needs an
 *  installed workspace to push into. */
const SCRIPT_EMAIL = "you@solutions-builder.local";
const SCRIPT_PASSWORD = "solutions-builder-script-session";
const SCRIPT_NAME = "You";

async function install(): Promise<void> {
  if (!(await signInEmail(SCRIPT_EMAIL, SCRIPT_PASSWORD))) {
    await signUpEmail({ email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD, name: SCRIPT_NAME });
  }
  await adoptLegacyWorkspaceOnce();
  await installerInstall(
    hubTransport(),
    { canPlaceSidecars: canPlaceSidecars(), sidecarFingerprint: hub().sidecarBindingFingerprint },
    { afterSkillAssets: async () => { await rerankCatalogProviders(); } },
  );
  hubClientForgetWorkspace();
  await resolveWorkspace();
}

/** The asset's human-readable name — how it's found and created. Distinct
 *  from the resolver's internal registry name (see `resolveAndPrintClosure`),
 *  which production keys to the asset id, not this. */
const REGISTRY_ASSET_NAME = "solutions-builder-packages";
const INDEX_PATH = "package-registry.json";

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
