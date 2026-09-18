/**
 * Exercises the real `mountArtifacts` composition this package wires in
 * `createEmbeddedHub` — a pglite-backed `ArtifactDb`, the real migrator, and
 * Interchange's real `createRequireGrant` — without standing up the whole
 * embedded hub (sidecars, auth, workflows), which `@corbits/artifacts` never
 * touches. A mutable in-memory `GrantStore` stands in for the hub's grant
 * table, the same seam `createRequireGrant` takes in production.
 */
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { InlineContentStore, mountArtifacts, runArtifactMigrations, type ArtifactDb } from "@corbits/artifacts";
import { withPostgresJsResultShape } from "./pg-compat.js";

const TENANT_ID = "t_test";
const PRINCIPAL_ID = "p_test";

/** Structural match to Interchange's own `GrantRule`/`GrantStore` — `createRequireGrant`'s
 * `grantStore` option is typed `unknown` in this repo's `@intx/hub-api` declarations, so
 * nothing upstream constrains this beyond what `authorize()` actually reads. */
type GrantRule = {
  id: string;
  resource: string;
  action: string;
  effect: "allow" | "deny" | "ask";
  origin: "system" | "role" | "creator" | "invoker";
  conditions: unknown;
  expiresAt: Date | null;
  roleId: string | null;
  principalId: string | null;
};
type GrantStore = {
  collectGrants(principalId: string, tenantId: string): Promise<GrantRule[]>;
  collectGrantsInChain(principalId: string, tenantId: string): Promise<GrantRule[]>;
};

function mutableGrantStore(): GrantStore & { grants: GrantRule[] } {
  const grants: GrantRule[] = [];
  return {
    grants,
    async collectGrants() {
      return grants;
    },
    async collectGrantsInChain() {
      return grants;
    },
  };
}

function grant(over: Pick<GrantRule, "resource" | "action">): GrantRule {
  return {
    id: `g_${over.resource}_${over.action}`,
    resource: over.resource,
    action: over.action,
    effect: "allow",
    origin: "creator",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: PRINCIPAL_ID,
  };
}

async function mountedApp(): Promise<{ app: Hono<TenantEnv>; grantStore: GrantStore & { grants: GrantRule[] } }> {
  const client = new PGlite();
  const db = drizzle(client);
  // The module's tables foreign-key into `public.tenant`/`public.principal`,
  // which Interchange's own migrations own. Standing up its full migration
  // set here would pull in unrelated control-plane history; a minimal stub
  // of the two referenced tables is enough for the mounted routes under test.
  await db.execute(sql`CREATE TABLE "tenant" ("id" text PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE "principal" ("id" text PRIMARY KEY)`);
  await db.execute(sql`INSERT INTO "tenant" ("id") VALUES (${TENANT_ID})`);
  await db.execute(sql`INSERT INTO "principal" ("id") VALUES (${PRINCIPAL_ID})`);
  const artifactDb = withPostgresJsResultShape(db) as unknown as ArtifactDb;
  await runArtifactMigrations(artifactDb);

  const grantStore = mutableGrantStore();
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    const now = new Date(0);
    c.set("tenant", {
      id: TENANT_ID,
      name: TENANT_ID,
      slug: TENANT_ID,
      domain: `${TENANT_ID}.example`,
      parentId: null,
      config: null,
      createdAt: now,
      updatedAt: now,
    });
    c.set("principal", {
      id: PRINCIPAL_ID,
      tenantId: TENANT_ID,
      kind: "user",
      refId: PRINCIPAL_ID,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await next();
  });
  mountArtifacts(app, {
    db: artifactDb,
    contentStore: InlineContentStore,
    requireGrant: createRequireGrant({ grantStore, conditionRegistry: {} }),
  });
  return { app, grantStore };
}

describe("mountArtifacts on the embedded hub's composition", () => {
  test("answers a write and a list under a tenant with grants", async () => {
    const { app } = await mountedApp();

    const created = await app.request("/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", title: "Plan", content: "the plan" }),
    });
    expect(created.status).toBe(201);
    const { artifact } = (await created.json()) as { artifact: { id: string; content: string } };
    expect(artifact.content).toBe("the plan");

    const listed = await app.request("/artifacts");
    expect(listed.status).toBe(200);
    const { artifacts } = (await listed.json()) as { artifacts: { id: string }[] };
    expect(artifacts.map((row) => row.id)).toContain(artifact.id);
  });

  test("revising a version is denied without a grant, and allowed with one", async () => {
    const { app, grantStore } = await mountedApp();

    const created = await app.request("/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", title: "Draft", content: "v1" }),
    });
    const { artifact } = (await created.json()) as { artifact: { id: string } };

    const denied = await app.request(`/artifacts/${artifact.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "v2" }),
    });
    expect(denied.status).toBe(403);

    grantStore.grants.push(grant({ resource: `artifact:${artifact.id}`, action: "write" }));

    const revised = await app.request(`/artifacts/${artifact.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "v2" }),
    });
    expect(revised.status).toBe(200);
    const body = (await revised.json()) as { version: number };
    expect(body.version).toBe(2);
  });
});
