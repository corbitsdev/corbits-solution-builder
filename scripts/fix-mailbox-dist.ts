#!/usr/bin/env bun
/**
 * `@corbits/mailbox` is installed as a bare git dependency (never published),
 * so its own `prepare` build never links its `vendor/*` workspace members —
 * that only happens inside its own repo. Left alone it ships no `dist/`,
 * and three of its own arktype-inferred exports fail TS2742 declaration
 * emit regardless (a bun-global-store path portability issue, independent
 * of this repo). This script links its local `@intx/{mailbox,mime,types}`
 * devDependencies to its own vendored copies, annotates the three exports
 * arktype can't infer a portable declaration for, and builds its `dist/`
 * for this workspace to import. Idempotent; safe to re-run every install.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKG_DIR = join(ROOT, "node_modules", "@corbits", "mailbox");

if (!existsSync(PKG_DIR)) {
  console.log("fix-mailbox-dist: @corbits/mailbox not installed, skipping");
  process.exit(0);
}

async function run(): Promise<void> {
  // 1. Link its own vendored @intx/{mailbox,mime,types} instead of falling
  // through to this repo's untyped `vendor/interchange` copies at build time.
  await Bun.$`bun install --ignore-scripts`.cwd(PKG_DIR).quiet();

  // 2. Annotate the three exports arktype can't print a portable declared
  // type for (bun's hashed global-store path is unreachable from dist/).
  const busPath = join(PKG_DIR, "src", "bus.ts");
  const busText = await Bun.file(busPath).text();
  if (!busText.includes(": Type<{ type: \"mailbox\"")) {
    await Bun.write(
      busPath,
      busText
        .replace('import { type } from "arktype";', 'import { type, type Type } from "arktype";')
        .replace(
          "export const MailboxEventSchema = type({",
          'export const MailboxEventSchema: Type<{ type: "mailbox"; id: string; op?: MailboxEventOp }> = type({',
        ),
    );
  }

  const writePath = join(PKG_DIR, "src", "write.ts");
  const writeText = await Bun.file(writePath).text();
  if (!writeText.includes(": Type<string> = type(\"string\")")) {
    await Bun.write(
      writePath,
      writeText
        .replace('import { type } from "arktype";', 'import { type, type Type } from "arktype";')
        .replace(
          'export const MailboxScopeIdSchema = type("string").narrow(',
          'export const MailboxScopeIdSchema: Type<string> = type("string").narrow(',
        )
        .replace(
          "export const MailboxScopeIdsSchema = type({",
          "export const MailboxScopeIdsSchema: Type<{ tenantId: string; principalId: string }> = type({",
        ),
    );
  }

  // 3. Build. Its own vendor-rewrite step (step 2 of scripts/build.mjs)
  // still fails on the same TS2742 issue across its vendored @intx/types,
  // but this repo never needs the self-contained dist/vendor/ output --
  // it already provides real @intx/mailbox, @intx/mime, @intx/types via
  // vendor/interchange, which the unrewritten bare specifiers resolve to.
  // tsc still emits step 1's dist/*.js and dist/*.d.ts before that failure,
  // which is all this workspace needs.
  await Bun.$`bun x tsc -p tsconfig.build.json`.cwd(PKG_DIR).quiet().nothrow();

  if (!existsSync(join(PKG_DIR, "dist", "index.js")) || !existsSync(join(PKG_DIR, "dist", "write.d.ts"))) {
    throw new Error("fix-mailbox-dist: dist/ did not build as expected");
  }
  console.log("fix-mailbox-dist: @corbits/mailbox dist/ is current");
}

await run();
