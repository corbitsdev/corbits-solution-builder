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
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** Real pid of the host that currently owns this directory. Sibling of PGDATA: pglite treats a non-empty data dir as an existing cluster, and its own lock file records `-42`. */
const HOST_PID_FILE_SUFFIX = ".host.pid";

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * pglite is single-writer. It writes `postmaster.pid` with a fake pid and
 * WASM-aborts on the next create if that file is still there, so a host that
 * was killed would otherwise brick the workspace. The host records its real
 * pid so a live second process is refused rather than becoming a second writer.
 */
async function claimDataDir(dataDir: string): Promise<{ root: string; release: () => Promise<void> }> {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true });
  const pidPath = `${root}${HOST_PID_FILE_SUFFIX}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(pidPath, `${process.pid}\n`, { flag: "wx" });
      await unlink(join(root, "postmaster.pid")).catch(() => undefined);
      return {
        root,
        release: async () => {
          await unlink(pidPath).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const existing = Number((await readFile(pidPath, "utf8").catch(() => "")).trim());
      if (processExists(existing)) {
        throw new Error(
          `Solutions Builder is already running (process ${existing}). ` +
            "Stop that host, or set SOLUTIONS_BUILDER_DATA_DIR to a different directory.",
        );
      }
      await unlink(pidPath).catch(() => undefined);
    }
  }

  throw new Error(`Could not claim the database directory at ${root}.`);
}

function openFailure(dataDir: string, cause: unknown): Error {
  return new Error(
    `Could not open the host database at ${dataDir}. ` +
      "A previous run may not have shut down cleanly. " +
      "Stop any other Solutions Builder using this workspace, " +
      "move that directory aside, or set SOLUTIONS_BUILDER_DATA_DIR to a different directory.",
    { cause: cause instanceof Error ? cause : undefined },
  );
}

/**
 * `dataDir` omitted means in-memory, which is what tests and the boundary
 * checker want. A packaged host always passes its application-support path.
 */
export async function openDatabase(dataDir?: string): Promise<HostDatabase> {
  if (open) return open;
  const bundled = await assets();
  let release: (() => Promise<void>) | undefined;
  let client: PGlite;
  if (dataDir) {
    const claimed = await claimDataDir(dataDir);
    release = claimed.release;
    try {
      client = await PGlite.create(claimed.root, bundled);
    } catch (cause) {
      await release();
      throw openFailure(claimed.root, cause);
    }
  } else {
    client = await PGlite.create(bundled);
  }
  const db = drizzle(client) as Db;
  open = {
    db,
    raw: client,
    artifactDb: withPostgresJsResultShape(db) as unknown as ArtifactDb,
    close: async () => {
      open = null;
      try {
        await client.close();
      } finally {
        await release?.();
      }
    },
  };
  return open;
}

export function database(): HostDatabase {
  if (!open) throw new Error("The host database is not open yet.");
  return open;
}
