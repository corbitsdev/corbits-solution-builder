#!/usr/bin/env bun
/**
 * Snapshots the workflow-closure file tree into
 * `packages/installer/src/workflow-closure-embed.ts` so `install()` can ship
 * the vendored members without walking `vendor/` at runtime. The web bundle
 * has no `node:fs`; this committed module is the tree.
 *
 * Run after `bun run vendor:build`. `--check` exits 1 when the committed
 * embed does not match what this walk would write.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { WORKFLOW_PACKAGE_DEPENDENCIES } from "../packages/solutions-builder/src/workflows/lifecycle-source.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "packages", "installer", "src", "workflow-closure-embed.ts");
const VENDORED_PACKAGES = join(ROOT, "vendor", "interchange", "packages");

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

function collectDist(shortName: string, files: Record<string, string>): void {
  const distDir = join(VENDORED_PACKAGES, shortName, "dist");
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `@intx/${shortName} has no dist/; run \`bun run vendor:build\` before embedding the workflow closure`,
    );
  }
  const paths: string[] = [];
  walk(distDir, paths);
  let runtime = 0;
  for (const full of paths) {
    const rel = posixRel(distDir, full);
    if (/\.d\.ts$/.test(rel) || /\.map$/.test(rel) || /\.test\.js$/.test(rel) || rel === ".emitted") continue;
    files[`vendor/interchange/packages/${shortName}/dist/${rel}`] = readUtf8(full);
    runtime += 1;
  }
  if (runtime === 0) {
    throw new Error(`@intx/${shortName} dist/ has no runtime files to embed`);
  }
}

function collectTools(name: string, files: Record<string, string>): void {
  const packageDir = join(ROOT, "packages", name);
  files[`packages/${name}/package.json`] = readUtf8(join(packageDir, "package.json"));
  const paths: string[] = [];
  walk(join(packageDir, "src"), paths);
  for (const full of paths) {
    if (/\.test\.tsx?$/.test(full)) continue;
    files[`packages/${name}/${posixRel(packageDir, full)}`] = readUtf8(full);
  }
}

function vendoredRoots(): string[] {
  const roots: string[] = [];
  for (const [name, spec] of Object.entries(WORKFLOW_PACKAGE_DEPENDENCIES)) {
    if (spec === "workspace:*" && name.startsWith("@intx/")) roots.push(name.slice("@intx/".length));
  }
  return roots;
}

function collect(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": readUtf8(join(ROOT, "package.json")),
    "packages/solutions-builder/src/deck.ts": readUtf8(join(ROOT, "packages", "solutions-builder", "src", "deck.ts")),
    "packages/solutions-builder/src/delivery.ts": readUtf8(
      join(ROOT, "packages", "solutions-builder", "src", "delivery.ts"),
    ),
    "packages/solutions-builder/src/admit.ts": readUtf8(join(ROOT, "packages", "solutions-builder", "src", "admit.ts")),
    "packages/solutions-builder/src/guard.ts": readUtf8(join(ROOT, "packages", "solutions-builder", "src", "guard.ts")),
    "packages/solutions-builder/src/project-state.ts": readUtf8(
      join(ROOT, "packages", "solutions-builder", "src", "project-state.ts"),
    ),
    "packages/solutions-builder/src/ledger.ts": readUtf8(join(ROOT, "packages", "solutions-builder", "src", "ledger.ts")),
    "packages/solutions-builder/src/kit.ts": readUtf8(join(ROOT, "packages", "solutions-builder", "src", "kit.ts")),
    "packages/solutions-builder/src/artifacts.ts": readUtf8(
      join(ROOT, "packages", "solutions-builder", "src", "artifacts.ts"),
    ),
    "packages/solutions-builder/src/requirements-example.ts": readUtf8(
      join(ROOT, "packages", "solutions-builder", "src", "requirements-example.ts"),
    ),
    "packages/solutions-builder/src/workflows/stage-loop.ts": readUtf8(
      join(ROOT, "packages", "solutions-builder", "src", "workflows", "stage-loop.ts"),
    ),
  };
  collectTools("tools-deck", files);
  collectTools("tools-delivery", files);

  const seen = new Set<string>();
  const queue = vendoredRoots();
  while (queue.length > 0) {
    const shortName = queue.shift()!;
    if (seen.has(shortName)) continue;
    seen.add(shortName);
    const manifestPath = join(VENDORED_PACKAGES, shortName, "package.json");
    files[`vendor/interchange/packages/${shortName}/package.json`] = readUtf8(manifestPath);
    collectDist(shortName, files);
    const manifest = JSON.parse(files[`vendor/interchange/packages/${shortName}/package.json`]!) as PackageManifest;
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec === "workspace:*" && name.startsWith("@intx/")) queue.push(name.slice("@intx/".length));
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function render(files: Record<string, string>): string {
  return `/**
 * Generated by \`bun scripts/embed-workflow-closure.ts\`. Do not edit by hand.
 * The installer \`install()\` path reads this snapshot instead of walking
 * \`vendor/\` so apps/web can import \`@solutions-builder/installer\` without
 * node:fs.
 */
export const WORKFLOW_CLOSURE_EMBED: Record<string, string> = JSON.parse(${JSON.stringify(JSON.stringify(files))});
`;
}

const files = collect();
const generated = render(files);
const check = process.argv.includes("--check");
if (check) {
  let existing = "";
  try {
    existing = readUtf8(OUT);
  } catch {
    console.error(`workflow-closure embed missing at ${OUT}; run bun scripts/embed-workflow-closure.ts`);
    process.exit(1);
  }
  if (existing !== generated) {
    console.error(
      "workflow-closure embed is stale; run `bun run vendor:build` then `bun scripts/embed-workflow-closure.ts`",
    );
    process.exit(1);
  }
  console.log(`workflow-closure embed is current (${Object.keys(files).length} files)`);
  process.exit(0);
}

writeFileSync(OUT, generated);
console.log(`wrote ${OUT} (${generated.length} bytes, ${Object.keys(files).length} files)`);
