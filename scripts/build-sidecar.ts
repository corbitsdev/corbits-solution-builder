/**
 * Compiles the host into a single self-contained binary for Tauri's
 * `externalBin`. A packaged app therefore needs neither Bun on PATH nor a
 * source checkout — the shape the Alpha spike proved.
 */
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outputRoot = join(root, "apps", "desktop", "binaries");

const TARGETS = {
  arm64: { bun: "bun-darwin-arm64", triple: "aarch64-apple-darwin" },
  x64: { bun: "bun-darwin-x64", triple: "x86_64-apple-darwin" },
} as const;

async function build(architecture: keyof typeof TARGETS) {
  const target = TARGETS[architecture];
  const output = join(outputRoot, `solutions-builder-host-${target.triple}`);
  const child = Bun.spawn(
    [
      "bun",
      "build",
      // The vendored Interchange packages publish their source under the
      // `intx-src` export condition and ship no `dist` in this tree, so the
      // compile resolves them the same way the runtime does.
      "--conditions",
      "intx-src",
      "apps/hub/src/server.ts",
      "--compile",
      `--target=${target.bun}`,
      `--outfile=${output}`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const status = await child.exited;
  if (status !== 0) throw new Error(`Sidecar compilation failed for ${target.triple} (${status}).`);
  await chmod(output, 0o755);
  console.log(`Built ${output}`);
}

// The host embeds pglite's WASM image and filesystem bundle by relative path,
// because the package does not export them. If a dependency change moves them,
// fail here rather than shipping a binary that cannot open its own database.
for (const asset of ["pglite.wasm", "pglite.data"]) {
  const path = join(root, "node_modules", "@electric-sql", "pglite", "dist", asset);
  if (!(await Bun.file(path).exists())) {
    throw new Error(
      `Expected pglite asset is missing: ${path}. ` +
        `Update the import paths in packages/embedded-host/src/db.ts to match.`,
    );
  }
}

await mkdir(outputRoot, { recursive: true });
const mode = process.argv[2] ?? "current";
if (mode === "all") {
  await build("arm64");
  await build("x64");
} else if (mode === "current") {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(`Unsupported sidecar architecture: ${process.arch}`);
  }
  await build(process.arch);
} else {
  throw new Error("Usage: bun scripts/build-sidecar.ts [current|all]");
}
