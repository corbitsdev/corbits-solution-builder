/**
 * Applies Interchange's own migrations to the host database.
 *
 * The SQL is embedded by `scripts/generate-hub-migrations.ts` rather than read
 * from disk, because the packaged host is a single file with no vendor
 * directory beside it. It is the vendored SQL, unmodified — Solutions Builder does not own the
 * hub's schema and must not drift from it. `exec` runs each file as a script,
 * the way the upstream migrator does, because several files hold more than one
 * statement.
 */
import { sql } from "drizzle-orm";
import type { HostDatabase } from "./db.js";
import { dataDirectory } from "./paths.js";
import { HUB_MIGRATIONS } from "./hub-migrations.generated.js";

/**
 * Raised when the workspace predates the hub. Its own class so the host can
 * report it as the actionable thing it is rather than as an internal error.
 */
export class PreHubDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreHubDatabaseError";
  }
}

function dataDirectoryHint(): string {
  return dataDirectory();
}

const LEDGER = "interchange_migrations";

export async function migrateHub(host: HostDatabase): Promise<{ applied: string[] }> {
  const { db, raw } = host;

  await db.execute(sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(LEDGER)} (
    "id" text PRIMARY KEY,
    "applied_at" timestamptz NOT NULL DEFAULT now()
  )`);
  const stamped = await db.execute<{ id: string }>(
    sql`SELECT "id" FROM ${sql.identifier(LEDGER)}`,
  );
  const seen = new Set((stamped.rows as { id: string }[]).map((row) => row.id));

  // A database created before the hub was mounted already has `tenant` and
  // `principal` from the control-plane stand-in this build used to carry. Its
  // ledger is empty, so migration 0000 would try to create them again and fail
  // with `42P07 relation "tenant" already exists` — which is what a person sees
  // as a crash on launch, with no idea why.
  //
  // The condition is the *shape* of the tables, not whether the ledger is
  // empty: a partially-applied run leaves a stamped row behind, and gating on
  // an empty ledger would skip this check exactly when it is needed.
  {
    const existing = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant'
    `);
    const columns = new Set(
      (existing.rows as { column_name: string }[]).map((row) => row.column_name),
    );

    if (columns.size > 0) {
      // Interchange's own `tenant` carries these; the stand-in never did.
      const isInterchangeShape = columns.has("slug") && columns.has("domain");
      if (!isInterchangeShape) {
        throw new PreHubDatabaseError(
          "This workspace was created before Solutions Builder mounted the Interchange hub, " +
            "and its control-plane tables have the older shape, so the hub's schema cannot be " +
            "applied over them.\n\n" +
            "Nothing has been changed. This build is pre-release and the data directory is not " +
            "migrated automatically, because deleting a workspace is not something a launch " +
            "should decide on its own.\n\n" +
            "To start fresh, remove the data directory and relaunch:\n" +
            `  rm -rf "${dataDirectoryHint()}"\n\n` +
            "To keep it, point the app at a different directory instead:\n" +
            "  SOLUTIONS_BUILDER_DATA_DIR=/some/other/path",
        );
      }
      // The tables are Interchange's own, from a run that got partway through.
      // Re-running is safe: every statement is `IF NOT EXISTS`-shaped or
      // idempotent, so the loop below simply catches up.
    }
  }

  const applied: string[] = [];

  for (const migration of HUB_MIGRATIONS) {
    if (seen.has(migration.id)) continue;

    // Applying a migration and recording that it was applied happen in one
    // transaction. Separately, a run interrupted between the two leaves tables
    // that no ledger row accounts for, and the next launch tries to create them
    // again — which surfaces as `42P07 relation "..." already exists` on a
    // database that is, as far as anyone can see, simply the one they had
    // yesterday.
    const body = migration.sql.replaceAll("--> statement-breakpoint", "");
    const stamp = `INSERT INTO "${LEDGER}" ("id") VALUES ('${migration.id.replace(/'/g, "''")}');`;
    await raw.exec(`BEGIN;\n${body}\n${stamp}\nCOMMIT;`).catch(async (cause: unknown) => {
      // pglite leaves the session in a failed transaction after an error; the
      // rollback is what lets the next migration — or the next launch — run.
      await raw.exec("ROLLBACK;").catch(() => undefined);

      // A workspace stamped by an earlier vendored revision is the common
      // cause, and it does not announce itself: the ledger says a migration
      // ran, the current revision has different SQL under that same id, and
      // the failure surfaces much later as an ALTER against a table nothing
      // ever created. Upstream's statements are not uniformly idempotent, so
      // this cannot be repaired by re-running.
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new PreHubDatabaseError(
        `The Interchange schema could not be brought up to date: ${detail}\n\n` +
          `This stopped at migration ${migration.id}, and ${seen.size} of ` +
          `${HUB_MIGRATIONS.length} were already recorded as applied. That usually means ` +
          "this workspace was migrated by an earlier vendored revision of Interchange, " +
          "whose migrations do not line up with this build's.\n\n" +
          "Nothing has been changed. This build is pre-release and a data directory is " +
          "never migrated across revisions automatically, because deleting a workspace is " +
          "not something a launch should decide on its own.\n\n" +
          "To start fresh, remove the data directory and relaunch:\n" +
          `  rm -rf "${dataDirectoryHint()}"\n\n` +
          "To keep it, point the app at a different directory instead:\n" +
          "  SOLUTIONS_BUILDER_DATA_DIR=/some/other/path",
      );
    });

    applied.push(migration.id);
  }

  return { applied };
}
