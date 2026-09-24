/**
 * Writes the shared workflow closure to static `.tgz` files plus a manifest,
 * shipped next to the web app rather than embedded in the JS bundle
 * (`packages/installer/src/workflow-closure-embed.ts`, unchanged by this
 * script — see CL-8334/CL-8381).
 *
 * The packed set is identical to `scripts/pack-registry-asset.ts`'s
 * (`scripts/closure-pack.ts` builds it once, for both): vendored `@intx/*`,
 * `@solutions-builder/app`, and every real npm dependency that closure
 * imports at runtime. That script pushes the set into a live hub asset for
 * local/dev seeding; this one writes the same bytes to disk under
 * `apps/web/public/closure/`, where the web app fetches them at deploy time
 * and `packages/installer/src/workflow-closure.ts` extracts the vendored
 * members into the git-push source tree.
 *
 * `manifest.json` lists `{ name, version, filename, sha256 }` per tarball:
 * the deploy-time step reads this to know what to fetch without touching
 * the vendor tree itself (it may run in the browser, which has no
 * `node:fs`).
 *
 * This script only writes files. It does not touch a hub, a database, or
 * the deploy path.
 *
 * Usage: `bun run assets:pack-closure`
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildManifest, buildPackedEntries, ROOT_DIR, VENDOR_PACKAGES_DIR } from "./closure-pack.js";

export const CLOSURE_OUT_DIR = join(ROOT_DIR, "apps", "web", "public", "closure");
export const MANIFEST_FILENAME = "manifest.json";

async function main(): Promise<void> {
  if (!existsSync(join(VENDOR_PACKAGES_DIR, "workflow", "dist"))) {
    throw new Error("vendored packages have no dist/; run `bun run vendor:build` first");
  }

  console.log("Packing @solutions-builder/app, the vendored @intx/* closure, and the real npm packages it imports...");
  const entries = await buildPackedEntries();
  const manifest = buildManifest("scripts/pack-closure-static.ts", entries);

  // Replace whatever `CLOSURE_OUT_DIR` held before, so a package dropped
  // from the closure does not linger as a stale tarball on disk.
  if (existsSync(CLOSURE_OUT_DIR)) {
    for (const name of readdirSync(CLOSURE_OUT_DIR)) rmSync(join(CLOSURE_OUT_DIR, name));
  } else {
    mkdirSync(CLOSURE_OUT_DIR, { recursive: true });
  }

  for (const entry of entries) {
    writeFileSync(join(CLOSURE_OUT_DIR, entry.filename), entry.bytes);
    console.log(`  wrote ${entry.filename} (${String(entry.bytes.byteLength)} bytes)`);
  }
  writeFileSync(join(CLOSURE_OUT_DIR, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `\nWrote ${String(entries.length)} tarball(s) and ${MANIFEST_FILENAME} to ${CLOSURE_OUT_DIR} (digest ${manifest.digest}).`,
  );
}

await main();
