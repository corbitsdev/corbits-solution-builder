/**
 * A data directory of the smoke's own.
 *
 * Every host path — settings files, build workspaces, deck files, the
 * embedded hub's data — comes from `dataDirectory()`, which falls back to the
 * real per-user location when `SOLUTIONS_BUILDER_DATA_DIR` is unset. A smoke
 * run without it would read the developer's own settings and write into the
 * developer's own workspace. So this is the first import of every in-process
 * smoke: when no directory was given, one is made for this run before any
 * host module can ask.
 *
 * The database is a separate choice. A smoke that ran in memory when no
 * directory was given keeps doing so, by reading `givenDataDir` rather than
 * the environment after this has run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the caller set, before this run claimed a directory of its own. */
export const givenDataDir: string | undefined = process.env.SOLUTIONS_BUILDER_DATA_DIR || undefined;

if (!givenDataDir) {
  process.env.SOLUTIONS_BUILDER_DATA_DIR = mkdtempSync(join(tmpdir(), "solutions-builder-smoke-"));
}

/** Where this run's host files go. */
export const smokeDataDir: string = process.env.SOLUTIONS_BUILDER_DATA_DIR!;

/**
 * `host-secrets.ts` and `credential-migration.ts` use real production account
 * names (`provider:anthropic`, `oauth:codex-oauth`, ...). Left to detect a
 * real macOS keychain, a smoke that stores or migrates one would read, or
 * overwrite and delete, a developer's own signed-in credentials — the
 * keychain is one per machine, not one per test run, unlike the data
 * directory above. Every in-process smoke forces the file-backed store.
 *
 * `SOLUTIONS_BUILDER_SMOKE` is the marker `host-secrets.ts` checks before it
 * honours the override at all — a real launch that somehow inherited
 * `SOLUTIONS_BUILDER_CREDENTIAL_BACKEND` from its environment must not have
 * its keychain silently downgraded to a file.
 */
process.env.SOLUTIONS_BUILDER_SMOKE ??= "1";
process.env.SOLUTIONS_BUILDER_CREDENTIAL_BACKEND ??= "file";
