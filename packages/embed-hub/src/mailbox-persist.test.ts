import { beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { DB } from "@intx/db";
import { ensureRunSession, type EventCollectorPort } from "./mailbox-persist.js";
import { withPostgresJsResultShape } from "./pg-compat.js";

// Only the columns `ensureRunSession` reads and writes; the real tables carry
// more, none of which it touches.
async function openDb() {
  const client = new PGlite();
  const db = withPostgresJsResultShape(drizzle(client)) as unknown as DB["db"];
  await db.execute(sql`CREATE TABLE "workflow_run" (
    "id" text PRIMARY KEY, "tenant_id" text NOT NULL, "definition_id" text NOT NULL,
    "principal_id" text, "address" text)`);
  await db.execute(sql`CREATE TABLE "workflow_run_launch_spec" (
    "anchor_run_id" text PRIMARY KEY, "session_id" text NOT NULL,
    "source_authority_principal_id" text NOT NULL)`);
  await db.execute(sql`CREATE TABLE "agent_session" (
    "id" text PRIMARY KEY, "tenant_id" text NOT NULL, "agent_id" text NOT NULL,
    "principal_id" text NOT NULL, "status" text NOT NULL,
    "created_at" timestamp NOT NULL, "updated_at" timestamp NOT NULL)`);
  return db;
}

function collectors(): EventCollectorPort & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    create: (address) => void created.push(address),
    has: (address) => created.includes(address),
  };
}

async function sessionPrincipal(db: DB["db"], id: string): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`SELECT "principal_id" AS "principalId" FROM "agent_session" WHERE "id" = ${id}`,
  )) as unknown as { principalId: string }[];
  return rows[0]?.principalId;
}

describe("ensureRunSession", () => {
  let db: DB["db"];

  beforeEach(async () => {
    db = await openDb();
    await db.execute(sql`INSERT INTO "workflow_run" VALUES ('run_1', 'tnt_1', 'wfd_1', NULL, 'run_1@ws.localhost')`);
    await db.execute(sql`INSERT INTO "workflow_run_launch_spec" VALUES ('run_1', 'ses_1', 'prn_deployer')`);
  });

  test("records the session at provision, before the run has a principal", async () => {
    const events = collectors();
    expect(await ensureRunSession({ db, eventCollectors: events, runId: "run_1" })).toBe("ses_1");
    expect(await sessionPrincipal(db, "ses_1")).toBe("prn_deployer");
    expect(events.created).toEqual(["run_1@ws.localhost"]);
  });

  test("moves the session to the run's own principal once the first trigger sets it", async () => {
    await ensureRunSession({ db, eventCollectors: collectors(), runId: "run_1" });
    await db.execute(sql`UPDATE "workflow_run" SET "principal_id" = 'prn_run' WHERE "id" = 'run_1'`);
    await ensureRunSession({ db, eventCollectors: collectors(), runId: "run_1" });
    expect(await sessionPrincipal(db, "ses_1")).toBe("prn_run");
  });

  test("records the run's own principal when it is already set", async () => {
    await db.execute(sql`UPDATE "workflow_run" SET "principal_id" = 'prn_run' WHERE "id" = 'run_1'`);
    await ensureRunSession({ db, eventCollectors: collectors(), runId: "run_1" });
    expect(await sessionPrincipal(db, "ses_1")).toBe("prn_run");
  });

  test("creates the event collector once", async () => {
    const events = collectors();
    await ensureRunSession({ db, eventCollectors: events, runId: "run_1" });
    await ensureRunSession({ db, eventCollectors: events, runId: "run_1" });
    expect(events.created).toEqual(["run_1@ws.localhost"]);
  });

  test("returns null for an unknown run and throws for a run with no launch spec", async () => {
    expect(await ensureRunSession({ db, eventCollectors: collectors(), runId: "run_missing" })).toBeNull();
    await db.execute(sql`INSERT INTO "workflow_run" VALUES ('run_2', 'tnt_1', 'wfd_1', NULL, 'run_2@ws.localhost')`);
    await expect(ensureRunSession({ db, eventCollectors: collectors(), runId: "run_2" })).rejects.toThrow(
      "no workflow_run_launch_spec",
    );
  });
});
