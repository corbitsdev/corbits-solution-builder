import { beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { DB } from "@intx/db";
import { createProcessProvisioner, rebindLegacyProcessAllocations } from "./process-provisioner.js";
import { withPostgresJsResultShape } from "./pg-compat.js";

const provisioner = (role: "deployment" | "probe", sidecarEntryPath: string) =>
  createProcessProvisioner({ role, dataDir: "/unused", runtimePath: "/bin/bun", sidecarEntryPath });

describe("process provisioner binding", () => {
  test("is independent of the sidecar entry path and the hub port", () => {
    expect(provisioner("deployment", "/a/sidecar.ts").bindingFingerprint).toBe(
      provisioner("deployment", "/b/sidecar.ts").bindingFingerprint,
    );
    expect(provisioner("deployment", "/a/sidecar.ts").bindingFingerprint).not.toBe(
      provisioner("probe", "/a/sidecar.ts").bindingFingerprint,
    );
  });
});

// Only the columns the rebind reads and writes.
async function openDb() {
  const db = withPostgresJsResultShape(drizzle(new PGlite())) as unknown as DB["db"];
  for (const table of ["sidecar_allocation", "workflow_probe"]) {
    await db.execute(
      sql.raw(`CREATE TABLE "${table}" ("id" text PRIMARY KEY, "provisioner_id" text NOT NULL,
        "provisioner_binding_fingerprint" text NOT NULL, "status" text NOT NULL, "updated_at" timestamp)`),
    );
  }
  return db;
}

async function fingerprints(db: DB["db"], table: string): Promise<Record<string, string>> {
  const rows = (await db.execute(
    sql.raw(`SELECT "id", "provisioner_binding_fingerprint" AS "fp" FROM "${table}"`),
  )) as unknown as { id: string; fp: string }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.fp]));
}

describe("rebindLegacyProcessAllocations", () => {
  let db: DB["db"];
  const legacy = (role: string, port: number) =>
    `process:v1:${role}:/old/checkout/sidecar.ts:ws://127.0.0.1:${port}/api/sidecars/ws`;

  beforeEach(async () => {
    db = await openDb();
    await db.execute(sql`INSERT INTO "sidecar_allocation" ("id", "provisioner_id", "provisioner_binding_fingerprint", "status") VALUES
      ('allocated', 'process', ${legacy("deployment", 49502)}, 'allocated'),
      ('replacing', 'process', ${legacy("deployment", 62671)}, 'replacing'),
      ('released', 'process', ${legacy("deployment", 49502)}, 'released'),
      ('other_id', 'container', ${legacy("deployment", 49502)}, 'allocated'),
      ('other_role', 'process', 'process:v1:deploymentx:/x:ws://h', 'allocated')`);
    await db.execute(sql`INSERT INTO "workflow_probe" ("id", "provisioner_id", "provisioner_binding_fingerprint", "status") VALUES
      ('probing', 'process', ${legacy("probe", 56059)}, 'probing'),
      ('succeeded', 'process', ${legacy("probe", 56059)}, 'succeeded')`);
  });

  test("binds live legacy rows to the fingerprint the current provisioner carries", async () => {
    await rebindLegacyProcessAllocations(db);
    const deployment = provisioner("deployment", "/new/checkout/sidecar.ts").bindingFingerprint;
    const probe = provisioner("probe", "/new/checkout/sidecar.ts").bindingFingerprint;
    const allocations = await fingerprints(db, "sidecar_allocation");
    expect(allocations["allocated"]).toBe(deployment);
    expect(allocations["replacing"]).toBe(deployment);
    expect((await fingerprints(db, "workflow_probe"))["probing"]).toBe(probe);
  });

  test("leaves terminal rows, other provisioners and other roles alone", async () => {
    await rebindLegacyProcessAllocations(db);
    const allocations = await fingerprints(db, "sidecar_allocation");
    expect(allocations["released"]).toBe(legacy("deployment", 49502));
    expect(allocations["other_id"]).toBe(legacy("deployment", 49502));
    expect(allocations["other_role"]).toBe("process:v1:deploymentx:/x:ws://h");
    expect((await fingerprints(db, "workflow_probe"))["succeeded"]).toBe(legacy("probe", 56059));
  });
});
