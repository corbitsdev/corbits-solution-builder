/**
 * Compiles each specialist package's `src/workflow.ts` into plain JS, once,
 * with `Bun.build`. `@intx/workflow` and `@intx/agent` stay external: the
 * sidecar resolves them from the closure `workflow-closure.ts` ships. Tool
 * packages stay external the same way. `./inference-source.js` stays external
 * too: the installer writes the tenant's model pin there at deploy time
 * (the same overlay `namer-source.js` is for the project workflow).
 *
 * The browser-driven installer cannot run `Bun.build`, so `main()` writes the
 * compiled JS under `apps/web/public/specialists/<id>/workflow.js`, fetched
 * at deploy time the same way `apps/web/public/project-workflow/` is.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT_DIR = join(import.meta.dir, "..");
export const SPECIALIST_PACK_OUT_DIR = join(ROOT_DIR, "apps", "web", "public", "specialists");

/** Role id → package directory under `packages/`. specialist-shared and
 *  specialist-runtime are not workflows. */
export const SPECIALIST_PACK_ROLES: readonly { readonly id: string; readonly dir: string }[] = [
  { id: "brainstormer", dir: "specialist-brainstormer" },
  { id: "constraints-mapper", dir: "specialist-constraints-mapper" },
  { id: "proposer", dir: "specialist-proposer" },
  { id: "experience-designer", dir: "specialist-experience-designer" },
  { id: "presentation-creator", dir: "specialist-presentation-creator" },
  { id: "requirements-author", dir: "specialist-requirements-author" },
  { id: "architect", dir: "specialist-architect" },
  { id: "senior-engineer-application", dir: "specialist-senior-engineer-application" },
  { id: "senior-engineer-quality", dir: "specialist-senior-engineer-quality" },
  { id: "senior-engineer-platform", dir: "specialist-senior-engineer-platform" },
  { id: "senior-engineer-security", dir: "specialist-senior-engineer-security" },
  { id: "estimator", dir: "specialist-estimator" },
  { id: "build-supervisor", dir: "specialist-build-supervisor" },
  { id: "delivery-verifier", dir: "specialist-delivery-verifier" },
  { id: "product-guide", dir: "specialist-product-guide" },
  { id: "namer", dir: "specialist-namer" },
  { id: "brief-evaluator", dir: "specialist-brief-evaluator" },
];

const EXTERNAL = [
  "@intx/workflow",
  "@intx/agent",
  "@solutions-builder/tools-delivery",
  "@solutions-builder/tools-deck",
  "@corbits/artifacts",
  "@intx/tools-posix",
];

async function packOne(dir: string): Promise<string> {
  const entry = join(ROOT_DIR, "packages", dir, "src", "workflow.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    external: EXTERNAL,
    plugins: [
      {
        name: "inference-source-external",
        setup(build) {
          build.onResolve({ filter: /\/inference-source\.js$/ }, () => ({ path: "./inference-source.js", external: true }));
        },
      },
    ],
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`specialist pack failed for ${dir}:\n${messages}`);
  }
  const output = result.outputs.find((file) => file.path.endsWith("/workflow.js"));
  if (!output) throw new Error(`specialist pack did not produce workflow.js for ${dir}`);
  return await output.text();
}

/** Compiles every specialist workflow to plain ESM JS, keyed by role id. */
export async function buildSpecialistWorkflowFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const role of SPECIALIST_PACK_ROLES) {
    files[role.id] = await packOne(role.dir);
  }
  return files;
}

export type SpecialistPackManifest = {
  readonly generatedBy: string;
  readonly digest: string;
  readonly files: Readonly<Record<string, string>>;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildSpecialistManifest(generatedBy: string, files: Record<string, string>): SpecialistPackManifest {
  const entries = Object.keys(files).sort();
  const digest = createHash("sha256");
  const shas: Record<string, string> = {};
  for (const name of entries) {
    const sha = sha256Hex(files[name]!);
    shas[name] = sha;
    digest.update(name);
    digest.update("\0");
    digest.update(sha);
    digest.update("\0");
  }
  return { generatedBy, digest: digest.digest("hex"), files: shas };
}

async function main(): Promise<void> {
  console.log("Compiling specialist workflow entries...");
  const files = await buildSpecialistWorkflowFiles();
  const manifest = buildSpecialistManifest("scripts/specialist-pack.ts", files);

  if (!existsSync(SPECIALIST_PACK_OUT_DIR)) mkdirSync(SPECIALIST_PACK_OUT_DIR, { recursive: true });
  for (const [id, content] of Object.entries(files)) {
    const dir = join(SPECIALIST_PACK_OUT_DIR, id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.js"), content);
    console.log(`  wrote specialists/${id}/workflow.js (${String(content.length)} bytes)`);
  }
  writeFileSync(join(SPECIALIST_PACK_OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote ${String(Object.keys(files).length)} specialist(s) and manifest.json to ${SPECIALIST_PACK_OUT_DIR} (digest ${manifest.digest}).`);
}

if (import.meta.main) await main();
