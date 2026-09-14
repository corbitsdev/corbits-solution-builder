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
