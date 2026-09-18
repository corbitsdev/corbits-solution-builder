/**
 * Makes a tenant's `package-registry` asset actually hold the closure's
 * static tarballs, uploading only what is missing.
 *
 * `scripts/pack-closure-static.ts` packs the shared closure (vendored
 * `@intx/*`, `@solutions-builder/app`, tools-deck, tools-delivery, real npm
 * deps) into static `.tgz` files plus a manifest, shipped next to the app
 * rather than embedded in the JS bundle. This module is the other half:
 * called from the workspace install path, it lists the tenant's registry
 * asset (creating it if the tenant has none yet), and pushes any tarball the
 * manifest names that the asset does not already carry.
 *
 * `Transport.fetch` (`@intx/hub-client`) always JSON-encodes its body
 * (`createBrowserTransport`, `apps/web/src/hub.ts`'s `createHubTransport`),
 * so it cannot carry a tarball's raw bytes to the hub's
 * `PUT /api/tenants/:scope/assets/:assetId/tarballs/:filename` route, which
 * wants the exact bytes verbatim. The raw upload is therefore not built on
 * `Transport`: the caller hands in `putTarball`, implemented over its own
 * raw `fetch` (the browser's `/hub` passthrough, or the embedded hub's
 * direct dispatch), the same way `SidecarCapability` is handed to `install()`
 * rather than assumed by this package.
 *
 * Idempotent: a tarball's filename encodes its package name and version, and
 * the build step packs deterministically for a given version, so the
 * manifest's sha256 is what actually changes when a package's content
 * changes — a changed sha256 means a bumped version means a new filename.
 * Re-running against an asset that already has every named filename does no
 * uploads at all, only the two list calls.
 */
import type { Transport } from "@intx/hub-client";
import { assetsFor } from "./hub.js";

/** The registry asset's human-readable name — how it's found and created.
 *  Kept in sync with `scripts/pack-registry-asset.ts`'s own constant: both
 *  paths (local/dev seeding via a direct hub write, and this install-time
 *  upload via the HTTP route) converge on the one asset a tenant's deploy
 *  resolves the closure from. */
export const REGISTRY_ASSET_NAME = "solutions-builder-packages";

export type ClosureManifestEntry = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
};

export type ClosureManifest = {
  readonly digest: string;
  readonly packages: readonly ClosureManifestEntry[];
};

/** Raw byte access the ensure step needs beyond what `Transport` carries. */
export type RegistryTarballUploader = {
  /** PUTs `bytes` verbatim at `tarballs/<filename>` on the asset. */
  putTarball(assetId: string, filename: string, bytes: Uint8Array): Promise<void>;
};

/** Finds the tenant's `package-registry` asset by name, creating it on first
 *  install. Never creates a second one: `assetsFor(...).list` is checked
 *  first every time. */
export async function ensureRegistryAssetId(transport: Transport, scope: string): Promise<string> {
  const assets = assetsFor(transport, scope);
  const existing = await assets.list("package-registry");
  const found = existing.find((asset) => asset.name === REGISTRY_ASSET_NAME);
  if (found) return found.id;
  const created = await assets.create({
    kind: "package-registry",
    name: REGISTRY_ASSET_NAME,
    displayName: "Solutions Builder packages",
  });
  return created.id;
}

/** The filenames already present under `tarballs/` on the asset — a plain
 *  JSON GET, safe over `Transport`. */
export async function existingTarballFilenames(
  transport: Transport,
  scope: string,
  assetId: string,
): Promise<Set<string>> {
  const rows = await transport.fetch<{ filename: string }[]>(
    "GET",
    `/api/tenants/${scope}/assets/${assetId}/tarballs`,
  );
  return new Set(rows.map((row) => row.filename));
}

/**
 * Ensures the tenant's registry asset holds every tarball the manifest
 * names, uploading only the ones it does not already have. Returns which
 * filenames were uploaded and which were already present, so the caller can
 * log or surface install progress without a second pass.
 */
export async function ensureRegistryTarballs(
  transport: Transport,
  scope: string,
  uploader: RegistryTarballUploader,
  manifest: ClosureManifest,
  fetchTarballBytes: (filename: string) => Promise<Uint8Array>,
): Promise<{ assetId: string; uploaded: string[]; skipped: string[] }> {
  const assetId = await ensureRegistryAssetId(transport, scope);
  const present = await existingTarballFilenames(transport, scope, assetId);

  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const entry of manifest.packages) {
    if (present.has(entry.filename)) {
      skipped.push(entry.filename);
      continue;
    }
    const bytes = await fetchTarballBytes(entry.filename);
    await uploader.putTarball(assetId, entry.filename, bytes);
    uploaded.push(entry.filename);
  }
  return { assetId, uploaded, skipped };
}
