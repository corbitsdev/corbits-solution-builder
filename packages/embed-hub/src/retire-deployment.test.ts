/**
 * The retire route against Interchange's own schema and stores: the vendored
 * migrations applied to pglite, the real allocation and dispatch stores, and
 * the real `createRequireGrant` over an in-memory grant store.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { createSidecarAllocationStore, createWorkflowRunDispatchStore, type AnyPgDatabase } from "@intx/db";
import * as intxSchema from "@intx/db/schema";
import type { GrantRule } from "@intx/authz";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { withPostgresJsResultShape } from "./pg-compat.js";
import { createRetireDeploymentApi } from "./retire-deployment.js";

const MIGRATIONS = join(import.meta.dir, "../../../vendor/interchange/packages/db/migrations");

let client: PGlite;
let db: AnyPgDatabase;

beforeAll(async () => {
  client = new PGlite();
  for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort()) {
    await client.exec(await readFile(join(MIGRATIONS, file), "utf8"));
  }
  db = withPostgresJsResultShape(drizzle(client, { schema: intxSchema })) as unknown as AnyPgDatabase;
  for (const tenant of ["t_a", "t_b"]) {
    await client.query(`INSERT INTO tenant (id, name, slug, domain) VALUES ($1, $1, $1, $1 || '.test')`, [tenant]);
    await client.query(`INSERT INTO principal (id, tenant_id, kind, ref_id, status) VALUES ($1, $2, 'user', $1, 'active')`, [`p_${tenant}`, tenant]);
    await client.query(`INSERT INTO workflow_definition (id, tenant_id, name) VALUES ($1, $2, $1)`, [`def_${tenant}`, tenant]);
  }
});

/** A deployment's anchor run, its run principal, a child run, an allocation, and an unsettled dispatch. */
async function deployment(id: string, tenant: string, allocationStatus = "allocated"): Promise<void> {
  await client.query(`INSERT INTO principal (id, tenant_id, kind, ref_id, status) VALUES ($1, $2, 'workflow', $1, 'active')`, [`p_${id}`, tenant]);
  await client.query(`INSERT INTO workflow_run (id, tenant_id, definition_id, anchor_run_id, principal_id, status) VALUES ($1, $2, $3, $1, $4, 'running')`, [id, tenant, `def_${tenant}`, `p_${id}`]);
  await client.query(`INSERT INTO workflow_run (id, tenant_id, definition_id, anchor_run_id, status) VALUES ($1 || '__loop__0', $2, $3, $1, 'running')`, [id, tenant, `def_${tenant}`]);
  await client.query(
    `INSERT INTO sidecar_allocation (id, anchor_run_id, tenant_id, provisioner_id, provisioner_api_version, provisioner_binding_fingerprint, status, generation)
     VALUES ($1, $2, $3, 'process', 1, 'fp', $4, 3)`,
    [`alloc_${id}`, id, tenant, allocationStatus],
  );
}

function grant(resource: string, action: string, principalId = "p_t_a"): GrantRule {
  return { id: `g_${resource}_${action}`, resource, action, effect: "allow", origin: "creator", conditions: null, expiresAt: null, roleId: null, principalId };
}

function app(grants: GrantRule[], tenant = "t_a"): Hono<TenantEnv> {
  const requireGrant = createRequireGrant({
    grantStore: { collectGrants: async () => grants, collectGrantsInChain: async () => grants },
    conditionRegistry: {},
  });
  const root = new Hono<TenantEnv>();
  root.use("*", async (c, next) => {
    const now = new Date(0);
    c.set("tenant", { id: tenant, name: tenant, slug: tenant, domain: `${tenant}.test`, parentId: null, config: null, createdAt: now, updatedAt: now });
    c.set("principal", { id: `p_${tenant}`, tenantId: tenant, kind: "user", refId: `p_${tenant}`, status: "active", createdAt: now, updatedAt: now } as never);
    await next();
  });
  const deps = { db, allocationStore: createSidecarAllocationStore(db), dispatchStore: createWorkflowRunDispatchStore(db) };
  root.route("/retire", createRetireDeploymentApi(deps, requireGrant));
  return root;
}

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return (await client.query<Record<string, unknown>>(sql, params)).rows;
}

describe("the deployment retire route", () => {
  test("releases the allocation through the platform's release path, failing the deployment's live runs", async () => {
    await deployment("dep_old", "t_a");
    await deployment("dep_live", "t_a");
    const res = await app([grant("workflow-run:dep_old", "manage")]).request("/retire/dep_old", { method: "POST" });
    expect(res.status).toBe(204);
    expect(await rows(`SELECT status, generation, failure_code FROM sidecar_allocation WHERE anchor_run_id = $1`, ["dep_old"])).toEqual([
      { status: "releasing", generation: 4, failure_code: "deployment_superseded" },
    ]);
    expect(await rows(`SELECT id, status FROM workflow_run WHERE anchor_run_id = $1 ORDER BY id`, ["dep_old"])).toEqual([
      { id: "dep_old", status: "failed" },
      { id: "dep_old__loop__0", status: "failed" },
    ]);
    expect(await rows(`SELECT status FROM principal WHERE id = $1`, ["p_dep_old"])).toEqual([{ status: "deactivated" }]);
    // The live deployment beside it is untouched.
    expect(await rows(`SELECT status, generation FROM sidecar_allocation WHERE anchor_run_id = $1`, ["dep_live"])).toEqual([{ status: "allocated", generation: 3 }]);
    expect(await rows(`SELECT status FROM workflow_run WHERE id = $1`, ["dep_live"])).toEqual([{ status: "running" }]);
  });

  test("is idempotent: a deployment already releasing or released is left as it is", async () => {
    await deployment("dep_twice", "t_a");
    const retire = () => app([grant("workflow-run:dep_twice", "manage")]).request("/retire/dep_twice", { method: "POST" });
    expect((await retire()).status).toBe(204);
    expect((await retire()).status).toBe(204);
    expect(await rows(`SELECT status, generation FROM sidecar_allocation WHERE anchor_run_id = $1`, ["dep_twice"])).toEqual([{ status: "releasing", generation: 4 }]);
    await client.query(`UPDATE sidecar_allocation SET status = 'released' WHERE anchor_run_id = $1`, ["dep_twice"]);
    expect((await retire()).status).toBe(204);
    expect(await rows(`SELECT status, generation FROM sidecar_allocation WHERE anchor_run_id = $1`, ["dep_twice"])).toEqual([{ status: "released", generation: 4 }]);
  });

  test("refuses a deployment in another tenant, even to a caller with a matching grant", async () => {
    await deployment("dep_other", "t_b");
    const res = await app([grant("workflow-run:dep_other", "manage")]).request("/retire/dep_other", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await rows(`SELECT status FROM sidecar_allocation WHERE anchor_run_id = $1`, ["dep_other"])).toEqual([{ status: "allocated" }]);
  });

  test("refuses a caller without manage on the deployment's run", async () => {
    await deployment("dep_guarded", "t_a");
    const res = await app([grant("workflow-run:dep_guarded", "read")]).request("/retire/dep_guarded", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await rows(`SELECT status FROM sidecar_allocation WHERE anchor_run_id = $1`, ["dep_guarded"])).toEqual([{ status: "allocated" }]);
  });

  test("a child run is not a deployment", async () => {
    await deployment("dep_parent", "t_a");
    const res = await app([grant("workflow-run:*", "manage")]).request("/retire/dep_parent__loop__0", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
