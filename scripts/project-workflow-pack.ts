/**
 * Compiles the project workflow's `interchange.workflow`/`actions`/`loops`
 * modules from their TypeScript source
 * (`packages/solutions-builder/src/project-workflow/{workflow,actions,loops}.ts`)
 * into plain JS, once, with `Bun.build` -- CL-8721 removes the hand-duplicated
 * `deployed/*.js` mirrors those files used to be.
 *
 * `@intx/workflow` is left external: the sidecar resolves it from the
 * vendored closure member `workflow-closure.ts` ships beside these files, not
 * from a bundled copy.
 *
 * `buildProjectWorkflowEntryFiles()` is pure output-in-memory, used directly
 * by a Node/Bun caller (the deployed proof script). The browser-driven
 * installer cannot run `Bun.build` itself, so `main()` below also writes the
 * compiled JS to static files under `apps/web/public/project-workflow/` --
 * the same same-origin-static-asset path the workflow closure tarballs
 * already use (`scripts/pack-closure-static.ts`) -- fetched at deploy time by
 * `apps/web/src/client.ts`, wired into `bun run ui:build`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT_DIR = join(import.meta.dir, "..");
const ENTRY_DIR = join(ROOT_DIR, "packages/solutions-builder/src/project-workflow");
export const PROJECT_WORKFLOW_OUT_DIR = join(ROOT_DIR, "apps", "web", "public", "project-workflow");

const ENTRIES = ["workflow", "actions", "loops"] as const;
type EntryName = (typeof ENTRIES)[number];

/** Compiles the three entry modules to plain ESM JS, keyed `<name>.js`. */
export async function buildProjectWorkflowEntryFiles(): Promise<Record<`${EntryName}.js`, string>> {
  const result = await Bun.build({
    entrypoints: ENTRIES.map((name) => join(ENTRY_DIR, `${name}.ts`)),
    target: "browser",
    format: "esm",
    external: ["@intx/workflow"],
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`project workflow pack failed:\n${messages}`);
  }
  const files: Partial<Record<`${EntryName}.js`, string>> = {};
  for (const output of result.outputs) {
    const name = ENTRIES.find((entry) => output.path.endsWith(`/${entry}.js`));
    if (!name) continue;
    files[`${name}.js`] = await output.text();
  }
  for (const name of ENTRIES) {
    if (!files[`${name}.js`]) throw new Error(`project workflow pack did not produce ${name}.js`);
  }
  return files as Record<`${EntryName}.js`, string>;
}

export type ProjectWorkflowManifest = {
  readonly generatedBy: string;
  readonly digest: string;
  readonly files: Readonly<Record<string, string>>;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A manifest naming each compiled file's own sha256, plus one digest over
 *  all of them, so a stale static build is detectable rather than silently
 *  deployed. */
export function buildManifest(generatedBy: string, files: Record<string, string>): ProjectWorkflowManifest {
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
  console.log("Compiling the project workflow's workflow/actions/loops modules...");
  const files = await buildProjectWorkflowEntryFiles();
  const manifest = buildManifest("scripts/project-workflow-pack.ts", files);

  if (!existsSync(PROJECT_WORKFLOW_OUT_DIR)) mkdirSync(PROJECT_WORKFLOW_OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(PROJECT_WORKFLOW_OUT_DIR, name), content);
    console.log(`  wrote ${name} (${String(content.length)} bytes)`);
  }
  writeFileSync(join(PROJECT_WORKFLOW_OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote ${String(Object.keys(files).length)} file(s) and manifest.json to ${PROJECT_WORKFLOW_OUT_DIR} (digest ${manifest.digest}).`);
}

if (import.meta.main) await main();
