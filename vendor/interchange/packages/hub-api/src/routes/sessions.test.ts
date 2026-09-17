import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { agentSession, inferenceTurn, turnPart, sessionMail } from "@intx/db/schema";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import type { TenantEnv, TenantRow, PrincipalRow } from "../context";
import { createRequireGrant } from "../middleware/grant";
import { createSessionRoutes } from "./sessions";

const TENANT_A = "tnt_a";
const TENANT_B = "tnt_b";
const SESSION_ID = "ses_test";
const CALLER_PRINCIPAL = "prn_caller";

const tenantA: TenantRow = {
  id: TENANT_A,
  name: "Tenant A",
  slug: "a",
  domain: "a.example.com",
  parentId: null,
  config: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

const callerPrincipal: PrincipalRow = {
  id: CALLER_PRINCIPAL,
  tenantId: TENANT_A,
  kind: "user",
  refId: "usr_a",
  status: "active",
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

function grant(action: string, overrides: Partial<GrantRule> = {}): GrantRule {
  return {
    id: `grant-session-${action}`,
    resource: "agent-session:*",
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: CALLER_PRINCIPAL,
    ...overrides,
  };
}

/** One grant per action the route group's three endpoints check. */
const ALL_GRANTS = [grant("create"), grant("manage"), grant("read")];

type SessionRow = { id: string; tenantId: string } | undefined;

type MockDBOpts = {
  /** The row `resolveSession`'s findFirst should return -- undefined stands
   * for "no session by this id in this tenant" (missing, or another
   * tenant's). */
  session?: SessionRow;
  turnPartRows?: Record<string, unknown>[];
  inferenceTurnRows?: Record<string, unknown>[];
};

function createMockDB(opts: MockDBOpts) {
  const inserted: { table: unknown; row: Record<string, unknown> }[] = [];

  function insertChain(table: unknown) {
    return {
      values: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return { onConflictDoNothing: async () => undefined };
      },
    };
  }

  function selectChain(table: unknown) {
    return {
      from: (fromTable: unknown) => ({
        where: async () => {
          if (fromTable === turnPart) return opts.turnPartRows ?? [];
          if (fromTable === inferenceTurn) return opts.inferenceTurnRows ?? [];
          return [];
        },
      }),
    };
  }

  return {
    query: {
      agentSession: { findFirst: async () => opts.session },
    },
    insert: insertChain,
    select: selectChain,
    inserted,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- drizzle PgDatabase cannot be structurally satisfied in tests
  } as unknown as Parameters<typeof createSessionRoutes>[0]["db"] & {
    inserted: { table: unknown; row: Record<string, unknown> }[];
  };
}

function createTestApp(opts: { db: MockDBOpts; grants?: GrantRule[] }) {
  const grantStore = createInMemoryGrantStore(opts.grants ?? ALL_GRANTS);
  const requireGrant = createRequireGrant({ grantStore, conditionRegistry: {} });

  // A stand-in signer: these tests assert what gets written to `session_mail`
  // as a database row (that a raw mail blob was inserted), not that the mail
  // verifies, so a fixed 64-byte "signature" is enough to drive
  // `createDetachedSignatureWithSigner` to completion.
  const principalKeyStore = {
    generate: async () => "kid",
    sign: async () => new Uint8Array(64),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- unused surface for these tests
  } as unknown as Parameters<typeof createSessionRoutes>[0]["principalKeyStore"];

  const db = createMockDB(opts.db);
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("user", null);
    c.set("session", null);
    c.set("tenant", tenantA);
    c.set("principal", callerPrincipal);
    await next();
  });
  app.route("/", createSessionRoutes({ db, principalKeyStore, requireGrant }));
  return { app, db };
}

describe("POST /sessions", () => {
  test("ensures a session for the caller's tenant", async () => {
    const { app, db } = await createTestApp({ db: {} });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, definitionId: "wfd_x", principalId: "prn_specialist" }),
    });
    expect(res.status).toBe(200);
    expect(db.inserted).toEqual([{ table: agentSession, row: expect.objectContaining({ tenantId: TENANT_A }) }]);
  });
});

describe("POST /sessions/:sessionId/turns — tenant scoping", () => {
  test("writing to a session owned by the caller's tenant succeeds", async () => {
    const { app, db } = await createTestApp({
      db: { session: { id: SESSION_ID, tenantId: TENANT_A } },
    });
    const res = await app.request(`/${SESSION_ID}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "",
        role: "human",
        body: "hello",
        fromPrincipalId: "prn_a",
        toPrincipalId: "prn_specialist",
        metadata: {},
        model: "human",
      }),
    });
    expect(res.status).toBe(200);
    expect(db.inserted.some((entry) => entry.table === inferenceTurn)).toBe(true);
    expect(db.inserted.some((entry) => entry.table === turnPart)).toBe(true);
    expect(db.inserted.some((entry) => entry.table === sessionMail)).toBe(true);
  });

  test("writing to a session owned by another tenant 404s and writes nothing", async () => {
    // The session id resolves, but not under TENANT_A -- the caller's own
    // tenant, resolved from the URL. resolveSession's tenant-scoped lookup
    // must miss, not the raw by-id lookup a cross-tenant write would need.
    const { app, db } = await createTestApp({ db: { session: undefined } });
    const res = await app.request(`/${SESSION_ID}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "",
        role: "human",
        body: "hello",
        fromPrincipalId: "prn_a",
        toPrincipalId: "prn_specialist",
        metadata: {},
        model: "human",
      }),
    });
    expect(res.status).toBe(404);
    expect(db.inserted).toEqual([]);
  });
});

describe("GET /sessions/:sessionId/turns — tenant scoping", () => {
  test("reads back every part on a session owned by the caller's tenant", async () => {
    const started = new Date("2025-01-01T00:00:00.000Z");
    const { app } = await createTestApp({
      db: {
        session: { id: SESSION_ID, tenantId: TENANT_A },
        inferenceTurnRows: [{ id: "itn_1", sessionId: SESSION_ID, startedAt: started }],
        turnPartRows: [
          { id: "tp_1", turnId: "itn_1", sessionId: SESSION_ID, content: "hi", metadata: null, ordinal: 0 },
        ],
      },
    });
    const res = await app.request(`/${SESSION_ID}/turns`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([
      { id: "tp_1", content: "hi", metadata: null, startedAt: started.toISOString() },
    ]);
  });

  test("reading a session owned by another tenant reads back empty, not that tenant's turns", async () => {
    const { app } = await createTestApp({
      db: {
        session: undefined,
        inferenceTurnRows: [{ id: "itn_1", sessionId: SESSION_ID, startedAt: new Date() }],
        turnPartRows: [
          { id: "tp_1", turnId: "itn_1", sessionId: SESSION_ID, content: "victim tenant's turn", metadata: null, ordinal: 0 },
        ],
      },
    });
    const res = await app.request(`/${SESSION_ID}/turns`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});
