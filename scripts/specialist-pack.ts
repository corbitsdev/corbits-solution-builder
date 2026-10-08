/**
 * Compiles each specialist package's `src/workflow.ts` into plain JS, once,
 * with `Bun.build`. `@intx/workflow` and `@intx/agent` stay external: the
 * sidecar resolves them from the closure `workflow-closure.ts` ships. Tool
 * packages stay external the same way. `./inference-source.js` and
 * `./workspace-guidance.js` stay external too: the installer writes the
 * tenant's model pin and the workspace's guidance there at deploy time (the
 * same overlay `namer-source.js` is for the project workflow).
 *
 * The browser-driven installer cannot run `Bun.build`, so `main()` writes the
 * compiled JS under `apps/web/public/specialists/<id>/workflow.js`, fetched
 * at deploy time the same way `apps/web/public/project-workflow/` is, with
 * the role package's declared dependencies beside it in `dependencies.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_KIT } from "@solutions-builder/app/kit";
import { SPECIALIST_DEPENDENCIES_PATH, SPECIALIST_ENTRY_PATH } from "@solutions-builder/app/specialist-source";

export const ROOT_DIR = join(import.meta.dir, "..");
export const SPECIALIST_PACK_OUT_DIR = join(ROOT_DIR, "apps", "web", "public", "specialists");

/** Every kit role is a `packages/specialist-<id>` workflow package; the kit
 *  is the one list, so a role added there is packed without a second edit. */
export const SPECIALIST_PACK_ROLES: readonly { readonly id: string; readonly dir: string }[] = AGENT_KIT.map((role) => ({
  id: role.id,
  dir: `specialist-${role.id}`,
}));

/** Left out of the bundle, so the packed entry imports them by name and the
 *  installer ships the members its role package declares (`specialistTooling`). */
export const EXTERNAL = [
  "@intx/workflow",
  "@intx/agent",
  "@solutions-builder/tools-delivery",
  "@solutions-builder/tools-deck",
  "@corbits/artifacts",
  "@intx/tools-posix",
];

export async function packSpecialist(dir: string): Promise<string> {
  const entry = join(ROOT_DIR, "packages", dir, "src", "workflow.ts");
  // Bun.build writes each module's path, relative to the working directory, as
  // a comment in the output, and a live specialist is redeployed whenever its
  // packed bytes differ. Building from the repository root keeps the bytes the
  // same wherever the pack is run from.
  const previous = process.cwd();
  process.chdir(ROOT_DIR);
  try {
    return await buildEntry(dir, entry);
  } finally {
    process.chdir(previous);
  }
}

async function buildEntry(dir: string, entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    external: EXTERNAL,
    plugins: [
      {
        name: "deploy-overlays-external",
        setup(build) {
          build.onResolve({ filter: /\/inference-source\.js$/ }, () => ({ path: "./inference-source.js", external: true }));
          build.onResolve({ filter: /\/workspace-guidance\.js$/ }, () => ({ path: "./workspace-guidance.js", external: true }));
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

/** The dependencies a role package declares in its own `package.json`, by
 *  name: what the installer ships beside its entry (`specialistTooling`). */
export function declaredDependencies(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT_DIR, "packages", dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {}).sort();
}

/** Compiles every specialist workflow to plain ESM JS, keyed by role id. */
export async function buildSpecialistWorkflowFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const role of SPECIALIST_PACK_ROLES) {
    files[role.id] = await packSpecialist(role.dir);
  }
  return files;
}

async function main(): Promise<void> {
  console.log("Compiling specialist workflow entries...");
  const files = await buildSpecialistWorkflowFiles();

  if (!existsSync(SPECIALIST_PACK_OUT_DIR)) mkdirSync(SPECIALIST_PACK_OUT_DIR, { recursive: true });
  for (const role of SPECIALIST_PACK_ROLES) {
    const content = files[role.id]!;
    const dir = join(SPECIALIST_PACK_OUT_DIR, role.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SPECIALIST_ENTRY_PATH), content);
    writeFileSync(join(dir, SPECIALIST_DEPENDENCIES_PATH), `${JSON.stringify(declaredDependencies(role.dir))}\n`);
    console.log(`  wrote specialists/${role.id}/ (${String(content.length)} bytes)`);
  }
  console.log(`\nWrote ${String(Object.keys(files).length)} specialist(s) to ${SPECIALIST_PACK_OUT_DIR}.`);
}

if (import.meta.main) await main();
