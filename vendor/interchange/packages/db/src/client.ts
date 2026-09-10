import { type } from "arktype";
import { drizzle } from "drizzle-orm/postgres-js";

import { DBConfig } from "./config";
import { createConnection } from "./connection";
import * as schema from "./schema";

/**
 * SOLUTIONS BUILDER VENDOR PATCH (see vendor/interchange/PATCHES.md).
 *
 * Upstream opens its own postgres.js socket, which requires a running Postgres
 * server. Solutions Builder is a local-first desktop app whose recorded
 * datastore is pglite — embedded, no socket — so it hands the hub a drizzle
 * handle it already owns instead.
 *
 * The patch is additive: passing a config still opens a connection exactly as
 * before. Only the `handle` form is new, and it is the one Solutions Builder
 * uses. Every store in this package goes through the returned `db`, so nothing
 * else in the hub needs to know which shape it got.
 *
 * Upstream-able as-is: this is dependency injection, not a behaviour change.
 */
export type InjectedHandle = {
  /** A drizzle handle bound to this package's schema, on any pg-dialect driver. */
  readonly handle: unknown;
  readonly close?: () => Promise<void>;
};

function isInjected(raw: unknown): raw is InjectedHandle {
  return typeof raw === "object" && raw !== null && "handle" in raw;
}

export function createDB(raw: unknown) {
  if (isInjected(raw)) {
    const db = raw.handle as ReturnType<typeof drizzle<typeof schema>>;
    return {
      db,
      transaction: db.transaction.bind(db),
      close: raw.close ?? (async () => undefined),
    };
  }

  const config = DBConfig(raw);
  if (config instanceof type.errors) {
    throw new Error(`Invalid database config: ${config.summary}`);
  }

  const sql = createConnection(config);
  const db = drizzle(sql, { schema });

  return {
    db,
    transaction: db.transaction.bind(db),
    close: () => sql.end(),
  };
}

export type DB = ReturnType<typeof createDB>;

/**
 * A handle that can execute queries: either the top-level `db` or a
 * transaction handle passed into a `db.transaction` callback. Store methods
 * that accept an optional `tx` type it against this so a caller can hand in
 * the transaction object and have the write join the surrounding transaction.
 * `DB["db"]` alone rejects a `PgTransaction` (it lacks the `$client` field the
 * top-level database carries), so a bare `DB["db"]` parameter cannot accept a
 * tx.
 */
export type DBExecutor =
  | DB["db"]
  | Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];
