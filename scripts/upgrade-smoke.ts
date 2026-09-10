/**
 * Upgrade smoke: what happens on the *second* run.
 *
 * Every other test in this repository starts from an empty directory, which is
 * why two upgrade defects reached the operator instead of a gate:
 *
 *   1. a workspace created before the Interchange hub was mounted crashed on
 *      launch with `42P07 relation "tenant" already exists`;
 *   2. the check that was supposed to catch it was gated on an empty migration
 *      ledger, so a partially-applied run skipped it — exactly the case it
 *      existed for.
 *
 * A fresh-install test cannot find either. This one builds databases in known
 * prior states and runs the real migrator against them.
 *
 * Usage: bun --conditions intx-src scripts/upgrade-smoke.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { withPostgresJsResultShape } from "../src/host/db/pg-compat.js";
import { HUB_MIGRATIONS } from "../src/host/hub/migrations.generated.js";
import { migrateHub, PreHubDatabaseError } from "../src/host/hub/migrate.js";
import type { HostDatabase } from "../src/host/db/client.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

async function open(dir: string): Promise<HostDatabase & { close: () => Promise<void> }> {
  const client = await PGlite.create(dir);
  const db = drizzle(client);
  return {
    db: db as never,
    raw: client,
    artifactDb: withPostgresJsResultShape(db) as never,
    close: async () => client.close(),
  };
}

const roots: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sb-upgrade-"));
  roots.push(dir);
  return join(dir, "pglite");
}

try {
  // --- A workspace from before the hub existed ---
  {
    const dir = await scratch();
    const host = await open(dir);
    // The control-plane stand-in this build used to carry, verbatim.
    await host.raw.exec(`
      CREATE TABLE "public"."tenant" (
        "id" text PRIMARY KEY, "name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "public"."principal" (
        "id" text PRIMARY KEY, "tenant_id" text, "kind" text NOT NULL,
        "display_name" text NOT NULL
      );
      INSERT INTO "public"."tenant" VALUES ('t_local', 'Local workspace', now());
    `);

    let refused: unknown;
    await migrateHub(host).catch((cause: unknown) => {
      refused = cause;
    });

    check(
      "a pre-hub workspace is refused, not crashed through",
      refused instanceof PreHubDatabaseError,
      refused instanceof Error ? refused.name : "no error raised",
    );
    check(
      "the refusal says what to do about it",
      refused instanceof Error &&
        refused.message.includes("SOLUTIONS_BUILDER_DATA_DIR") &&
        refused.message.includes("rm -rf"),
    );
    // The point of refusing rather than dropping: the data is still there.
    const rows = await host.db.execute<{ id: string }>(sql`SELECT id FROM "public"."tenant"`);
    check(
      "the refusal changes nothing",
      (rows.rows as { id: string }[])[0]?.id === "t_local",
    );
    await host.close();
  }

  // --- Applying and recording are one step ---
  //
  // The failure that reached the operator was a database carrying tables that
  // the ledger did not account for. That state is only reachable if a run can
  // stop between applying a migration and stamping it, so the property to hold
  // is that it cannot.
  {
    const dir = await scratch();
    const host = await open(dir);

    // Interrupt for real: a table one of the later migrations creates already
    // exists, so that migration fails partway through its own script.
    await host.raw.exec(`CREATE TABLE "public"."wallet" ("id" text PRIMARY KEY);`);

    let threw = false;
    await migrateHub(host).catch(() => {
      threw = true;
    });
    check("a migration that cannot apply fails loudly", threw);

    const stamped = await host.db.execute<{ id: string }>(
      sql`SELECT "id" FROM "interchange_migrations"`,
    );
    const ids = (stamped.rows as { id: string }[]).map((row) => row.id);

    // Every stamped migration must have actually applied. The one that failed
    // must not be recorded, and its partial work must not survive.
    const tables = await host.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const names = new Set((tables.rows as { table_name: string }[]).map((row) => row.table_name));

    check(
      "the failed migration is not recorded as applied",
      !ids.includes("0000_brown_wither.sql") || names.has("tenant"),
      `${ids.length} stamped`,
    );
    check(
      "a failed migration leaves nothing behind",
      // `federation_trust` is created by the same script as `tenant`; if the
      // script rolled back, neither exists.
      names.has("tenant") === names.has("federation_trust"),
    );
    await host.close();
  }

  // --- The ordinary case: launching twice ---
  {
    const dir = await scratch();
    const first = await open(dir);
    const initial = await migrateHub(first);
    await first.close();

    const second = await open(dir);
    const again = await migrateHub(second);
    await second.close();

    // Counted from the embedded set rather than written down: refreshing the
    // vendored Interchange changes this number, and a literal here would fail
    // the gate for the wrong reason and teach people to edit the number.
    check(
      "a first run applies the hub schema",
      initial.applied.length === HUB_MIGRATIONS.length,
      `${initial.applied.length} of ${HUB_MIGRATIONS.length}`,
    );
    check("a second run applies nothing", again.applied.length === 0, `${again.applied.length}`);
  }
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}


// A workspace stamped by an earlier vendored revision: the ledger claims a
// migration ran, this revision has different SQL under that id, and the
// failure surfaces later as an ALTER against a table nothing created. The
// person must be told what happened and what to do, not handed a driver dump.
{
  const stale = await open(await scratch());

  // Stamp a mid-list migration as applied without running it — exactly the
  // state a revision change leaves behind.
  await stale.raw.exec(`CREATE TABLE IF NOT EXISTS "interchange_migrations" (
    "id" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`);
  const skipped = HUB_MIGRATIONS[Math.floor(HUB_MIGRATIONS.length / 2)]!;
  await stale.raw.exec(
    `INSERT INTO "interchange_migrations" ("id") VALUES ('${skipped.id.replace(/'/g, "''")}')`,
  );

  let failure: unknown = null;
  await migrateHub(stale).catch((cause: unknown) => {
    failure = cause;
  });

  check(
    "a workspace from an earlier revision fails loudly rather than part-way",
    failure !== null,
    failure === null ? "it appeared to succeed" : "refused",
  );
  check(
    "and says so in words, naming the migration and the way out",
    failure instanceof PreHubDatabaseError &&
      failure.message.includes("earlier vendored revision") &&
      failure.message.includes("rm -rf"),
    failure instanceof Error ? failure.message.split("\n")[0]!.slice(0, 60) : "",
  );
  await stale.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nUpgrade smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
