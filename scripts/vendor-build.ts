#!/usr/bin/env bun
/**
 * Emits `dist/` for every vendored Interchange package whose exports point at
 * one. The vendored tree is consumed from source in-process (Bun's `intx-src`
 * condition), but a sidecar that evaluates deployed workflow packages must
 * run without that condition: published `@intx/*` tarballs carry the same
 * condition pointing at source they do not ship. With `dist/` present the
 * sidecar resolves vendored and published packages the same way.
 *
 * Idempotent: a package is rebuilt only when a source file is newer than its
 * last emit. Emit only, no type check; the workspace typecheck owns that.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteDistTree } from "../vendor/interchange/bin/dist-rewrite";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES = join(ROOT, "vendor", "interchange", "packages");
const STAMP = ".emitted";
const CONCURRENCY = 4;

type Target = { name: string; dir: string };

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

async function targets(): Promise<Target[]> {
  const out: Target[] = [];
  for (const name of readdirSync(PACKAGES)) {
    const dir = join(PACKAGES, name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = (await Bun.file(manifestPath).json()) as {
      name: string;
      exports?: Record<string, { default?: string }>;
    };
    const emitsDist = Object.values(manifest.exports ?? {}).some((entry) =>
      entry.default?.startsWith("./dist"),
    );
    if (emitsDist) out.push({ name: manifest.name, dir });
  }
  return out;
}

function stale(target: Target): boolean {
  const stamp = join(target.dir, "dist", STAMP);
  if (!existsSync(stamp)) return true;
  return newestMtime(join(target.dir, "src")) > statSync(stamp).mtimeMs;
}

const config = JSON.stringify({
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    customConditions: ["intx-src"],
    lib: ["ESNext"],
    allowJs: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    moduleDetection: "force",
    isolatedModules: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    noCheck: true,
    declaration: false,
    outDir: "./dist",
    rootDir: "./src",
  },
  include: ["src/**/*.ts"],
  exclude: ["**/*.test.ts"],
});

async function emit(target: Target): Promise<void> {
  const configPath = join(target.dir, "tsconfig.dist.generated.json");
  const dist = join(target.dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  writeFileSync(configPath, config);
  try {
    const tsc = Bun.spawn([join(ROOT, "node_modules", ".bin", "tsc"), "-p", configPath], {
      cwd: target.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      tsc.exited,
      new Response(tsc.stdout).text(),
      new Response(tsc.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`vendor-build: tsc failed for ${target.name}:\n${stdout.trim() || stderr.trim()}`);
    }
    const { unresolved } = rewriteDistTree(dist);
    if (unresolved.length > 0) {
      throw new Error(
        `vendor-build: ${target.name} has unresolved relative specifiers:\n  ${unresolved.join("\n  ")}`,
      );
    }
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, STAMP), "");
  } finally {
    rmSync(configPath, { force: true });
  }
}

const all = await targets();
const work = all.filter(stale);
const queue = [...work];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await emit(next);
  }),
);
console.log(`vendor-build: ${work.length} emitted, ${all.length - work.length} current`);
