import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { DB } from "@intx/db";
import * as intxSchema from "@intx/db/schema";
import type { MailboxPersistArgs } from "@corbits/mailbox";
import type { SidecarMailPersistedRow } from "@intx/hub-sessions";
import { createHubPersistMailSkippingSessionless } from "./mailbox-persist.js";
import { withPostgresJsResultShape } from "./pg-compat.js";

// Only the columns `resolveRoutableAddress` reads.
async function openDb(): Promise<DB["db"]> {
  const db = withPostgresJsResultShape(drizzle(new PGlite(), { schema: intxSchema })) as unknown as DB["db"];
  await db.execute(sql`CREATE TABLE "workflow_run" (
    "id" text PRIMARY KEY, "tenant_id" text NOT NULL, "public_key" text, "status" text NOT NULL,
    "principal_id" text, "address" text, "ended_at" timestamp)`);
  await db.execute(sql`CREATE TABLE "agent_session" (
    "id" text PRIMARY KEY, "principal_id" text NOT NULL, "ended_at" timestamp,
    "created_at" timestamp NOT NULL DEFAULT now())`);
  await db.execute(sql`INSERT INTO "workflow_run" VALUES
    ('run_1', 'tnt_1', NULL, 'running', 'prn_1', 'run1@t.test', NULL),
    ('run_2', 'tnt_1', NULL, 'running', 'prn_2', 'run2@t.test', NULL)`);
  await db.execute(sql`INSERT INTO "agent_session" ("id", "principal_id") VALUES ('ses_2', 'prn_2')`);
  return db;
}

function args(senderAddress: string): MailboxPersistArgs {
  return { senderAddress, recipients: ["someone@t.test"], raw: new Uint8Array() };
}

describe("createHubPersistMailSkippingSessionless", () => {
  test("skips the vendored write for a run with no session, and for a non-run sender", async () => {
    const db = await openDb();
    const seen: string[] = [];
    const row = { address: "run2@t.test" } as unknown as SidecarMailPersistedRow;
    const persist = createHubPersistMailSkippingSessionless(db, async (a) => {
      seen.push(a.senderAddress);
      return [row];
    });
    expect(await persist(args("run1@t.test"))).toEqual([]);
    expect(await persist(args("person@t.test"))).toEqual([]);
    expect(await persist(args("run2@t.test"))).toEqual([row]);
    expect(seen).toEqual(["run2@t.test"]);
  });
});
