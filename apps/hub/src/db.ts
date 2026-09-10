/**
 * The host-owned database handle — BUILD_PLAN_V3 section 11.
 *
 * pglite (embedded Postgres via WASM) is the operator's recorded choice: real
 * Postgres semantics in-process, and a hosted deployment later is a driver and
 * connection-string swap rather than a storage rewrite. Every module that needs
 * storage takes the handle from here; nothing opens its own.
 *
 * pglite is single-writer, which fits the local single-user model. That is a
 * property to design against, not a bug: writes go through `transact` so a
 * state change, its audit row and its outbox row land together or not at all.
 */
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
// pglite loads its WASM image and filesystem bundle from disk at runtime, which
// `bun build --compile` does not follow. Importing them as assets embeds them
// in the single-file host, and `assets()` hands them back to pglite explicitly.
// Found by running the compiled sidecar.
// The package does not export these two files, so they are reached by path.
// `scripts/build-sidecar.ts` asserts they exist before compiling, so a hoisting
// change fails the build rather than the packaged app.
import wasmPath from "../../../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import dataPath from "../../../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { withPostgresJsResultShape } from "./pg-compat.js";
import type { ArtifactDb } from "@corbits/artifacts";

export type Db = PgliteDatabase<Record<string, never>>;

/**
 * The WASM module and filesystem bundle, read from the embedded assets. In a
 * source checkout these resolve to files in node_modules; in the compiled
 * binary they resolve inside it. Either way pglite is handed them rather than
 * left to find them.
 */
async function assets() {
  const [wasm, data] = await Promise.all([
    Bun.file(wasmPath).arrayBuffer(),
    Bun.file(dataPath).arrayBuffer(),
  ]);
  return {
    wasmModule: await WebAssembly.compile(wasm),
    fsBundle: new Blob([data]),
  };
}

export type HostDatabase = {
  readonly db: Db;
  /**
   * The pglite client itself. `exec` runs a multi-statement script the way psql
   * would, which the Interchange migrations need — drizzle's `execute` takes one
   * statement. Nothing else should reach past `db`.
   */
  readonly raw: PGlite;
  /**
   * The same database, shaped for packages written against postgres.js.
   * `@corbits/artifacts` takes this one; Builder's own code takes `db`.
   */
  readonly artifactDb: ArtifactDb;
  readonly close: () => Promise<void>;
};

let open: HostDatabase | null = null;

/**
 * `dataDir` omitted means in-memory, which is what tests and the boundary
 * checker want. A packaged host always passes its application-support path.
 */
export async function openDatabase(dataDir?: string): Promise<HostDatabase> {
  if (open) return open;
  const bundled = await assets();
  // pglite will not create a missing parent, so the handle owns that rather
  // than every caller remembering to.
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const client = dataDir
    ? await PGlite.create(dataDir, bundled)
    : await PGlite.create(bundled);
  const db = drizzle(client) as Db;
  open = {
    db,
    raw: client,
    artifactDb: withPostgresJsResultShape(db) as unknown as ArtifactDb,
    close: async () => {
      open = null;
      await client.close();
    },
  };
  return open;
}

export function database(): HostDatabase {
  if (!open) throw new Error("The host database is not open yet.");
  return open;
}
