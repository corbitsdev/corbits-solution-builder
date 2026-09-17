import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnv } from "../context";
import { createTenantRoutes } from "./tenants";

const PARENT_ID = "tnt_parent";
const OTHER_TENANT_ID = "tnt_other";
const USER_ID = "usr_test";

const now = new Date("2025-01-01");

function childRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tnt_child",
    name: "Child",
    slug: "child",
    domain: "child.example.com",
    parentId: PARENT_ID,
    config: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type MockDBOpts = {
  // db.query.principal.findFirst — the caller's membership in ?parentId=.
  membership?: Record<string, unknown> | undefined;
  // db.query.tenant.findMany — the children returned for that parent.
  children?: Record<string, unknown>[];
};

function createMockDB(opts: MockDBOpts) {
  return {
    query: {
      principal: { findFirst: async () => opts.membership },
      tenant: { findMany: async () => opts.children ?? [] },
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- drizzle PgDatabase cannot be structurally satisfied in tests
  } as unknown as Parameters<typeof createTenantRoutes>[0]["db"];
}

function createTestApp(opts: { db: MockDBOpts; signedIn?: boolean }) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "user",
      opts.signedIn === false
        ? null
        : {
            id: USER_ID,
            createdAt: now,
            updatedAt: now,
            email: "t@example.com",
            emailVerified: true,
            name: "Test",
          },
    );
    c.set("session", null);
    await next();
  });
  app.route(
    "/",
    createTenantRoutes({
      db: createMockDB(opts.db),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- unused by GET /
      principalKeyStore: {} as Parameters<typeof createTenantRoutes>[0]["principalKeyStore"],
    }),
  );
  return app;
}

describe("GET /api/tenants?parentId=", () => {
  test("a member of the parent lists its children, oldest first", async () => {
    const app = createTestApp({
      db: {
        membership: { id: "prn_x", tenantId: PARENT_ID, kind: "user", refId: USER_ID },
        children: [childRow()],
      },
    });
    const res = await app.request(`/?parentId=${PARENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([
      {
        id: "tnt_child",
        name: "Child",
        slug: "child",
        domain: "child.example.com",
        parentId: PARENT_ID,
        config: undefined,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  });

  test("a non-member of the parent is refused, not handed the children", async () => {
    const app = createTestApp({
      db: {
        membership: undefined,
        children: [childRow()],
      },
    });
    const res = await app.request(`/?parentId=${OTHER_TENANT_ID}`);
    expect(res.status).toBe(403);
  });

  test("missing parentId is a bad request, not an unscoped listing", async () => {
    const app = createTestApp({ db: { membership: undefined } });
    const res = await app.request("/");
    expect(res.status).toBe(400);
  });

  test("an unauthenticated caller is refused", async () => {
    const app = createTestApp({ db: {}, signedIn: false });
    const res = await app.request(`/?parentId=${PARENT_ID}`);
    expect(res.status).toBe(401);
  });
});
