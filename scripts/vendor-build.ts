#!/usr/bin/env bun
/**
 * Emits `dist/` for every vendored Interchange package whose exports point at
 * one. The vendored tree is consumed from source in-process (Bun's `intx-src`
 * condition), but a sidecar that evaluates deployed workflow packages must
 * run without that condition: published `@intx/*` tarballs carry the same
 * condition pointing at source they do not ship. With `dist/` present the
 * sidecar resolves vendored and published packages the same way.
 *
 * Idempotent: a package is rebuilt only when its sources or the emit settings
 * differ from what the last emit recorded. The record is a digest rather than a
 * timestamp so an emitted `dist/` stays valid across a fresh checkout, a branch
 * switch, or a CI cache restore — none of which preserve modification times.
 * Emit only, no type check; the workspace typecheck owns that.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { rewriteDistTree } from "../vendor/interchange/bin/dist-rewrite";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES = join(ROOT, "vendor", "interchange", "packages");
const STAMP = ".emitted";
const REWRITE = join(ROOT, "vendor", "interchange", "bin", "dist-rewrite.ts");
const CONCURRENCY = 4;

type Target = { name: string; dir: string };

/** Everything under `src` that is not a test; the emit resolves JSON too. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel));
    else if (!entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
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

function sourceDigest(target: Target): string {
  const src = join(target.dir, "src");
  // `emit` post-processes tsc's output with `rewriteDistTree`, so the rewriter
  // is as much an input to what lands in `dist/` as the sources and the
  // compiler settings are.
  const hash = createHash("sha256").update(config).update(readFileSync(REWRITE));
  for (const rel of sourceFiles(src).sort()) {
    // NUL cannot occur in a path, so the name and the bytes cannot be read as
    // each other: without it `a.ts` holding `bc` digests as `a.tsbc` holding
    // nothing, and a rename that shifts a byte into a file goes unnoticed.
    hash.update(rel).update("\0").update(readFileSync(join(src, rel)));
  }
  return hash.digest("hex");
}

function stale(target: Target): boolean {
  const stamp = join(target.dir, "dist", STAMP);
  if (!existsSync(stamp)) return true;
  return readFileSync(stamp, "utf8").trim() !== sourceDigest(target);
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
  const digest = sourceDigest(target);
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
    writeFileSync(join(dist, STAMP), digest);
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
