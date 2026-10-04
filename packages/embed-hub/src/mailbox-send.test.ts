import { beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import {
  buildMailFrame,
  createInMemoryMailboxEventBus,
  openNativeMailboxStore,
  runMailboxMigrations,
  type MailboxDb,
  type MailboxEvent,
} from "@corbits/mailbox";
import { captureMailboxRequest, createMailboxDeliver, recordTriggerId, TRIGGER_FLAG_PREFIX, withdrawSentCopy } from "./mailbox-send.js";
import { withPostgresJsResultShape } from "./pg-compat.js";

const SCOPE = { tenantId: "tnt_1", principalId: "prn_owner" };
const RUN = "run_a1b2c3d4e5f60718293a4b5c6d7e8f90";
const RUN_ADDRESS = `${RUN}@sb-project.localhost`;

async function openDb(): Promise<MailboxDb> {
  const db = withPostgresJsResultShape(drizzle(new PGlite())) as unknown as MailboxDb;
  await db.execute(sql`CREATE TABLE "tenant" ("id" text PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE "principal" ("id" text PRIMARY KEY, "tenant_id" text NOT NULL REFERENCES "tenant" ("id"), "ref_id" text NOT NULL)`);
  await db.execute(sql`INSERT INTO "tenant" VALUES (${SCOPE.tenantId})`);
  await db.execute(sql`INSERT INTO "principal" VALUES (${SCOPE.principalId}, ${SCOPE.tenantId}, 'owner')`);
  await runMailboxMigrations(db);
  return db;
}

/** What the send route does before `deliver`: a Sent copy of the message. */
async function appendSent(db: MailboxDb, messageId: string): Promise<Uint8Array> {
  const raw = buildMailFrame({ from: "owner@ws.localhost", to: RUN_ADDRESS, subject: "Draft", body: "Please review.", messageId });
  const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
  sent.append(
    raw,
    { messageId, from: "owner@ws.localhost", to: [RUN_ADDRESS], subject: "Draft", date: new Date(), inReplyTo: undefined, references: [], interchangeType: undefined, interchangeCorrelationId: undefined },
    [],
  );
  await sent.settled;
  return raw;
}

async function folderIds(db: MailboxDb, folder: string): Promise<string[]> {
  const store = await openNativeMailboxStore(db, { ...SCOPE, folder });
  return store.messages.map((message) => message.envelope.messageId);
}

/** Runs `deliver` under a request the way the run-mailbox mount's middleware leaves it. */
async function deliverUnderRequest(
  deliver: ReturnType<typeof createMailboxDeliver>,
  message: Parameters<ReturnType<typeof createMailboxDeliver>>[0],
): Promise<Error | null> {
  const app = new Hono();
  app.use("/api/tenants/:tenantId/mailbox/me/inbox/send", captureMailboxRequest());
  let failure: Error | null = null;
  app.post("/api/tenants/:tenantId/mailbox/me/inbox/send", async (c) => {
    const set = (c as unknown as { set(key: string, value: unknown): void }).set.bind(c);
    set("tenant", { id: SCOPE.tenantId });
    set("principal", { id: SCOPE.principalId });
    try {
      await deliver(message);
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
    }
    return c.text("ok");
  });
  await app.request(`http://hub/api/tenants/${SCOPE.tenantId}/mailbox/me/inbox/send`, { method: "POST" });
  return failure;
}

const hubAnswering = (status: number, body: unknown) => ({ request: async () => new Response(JSON.stringify(body), { status }) });

describe("createMailboxDeliver", () => {
  let db: MailboxDb;
  beforeEach(async () => {
    db = await openDb();
  });

  // #61: the mailbox appends to Sent before deliver runs. A trigger the hub
  // refuses must not leave that copy looking sent.
  test("a refused trigger moves the Sent copy to Trash and still fails the send", async () => {
    const messageId = "<undelivered@ws.localhost>";
    const raw = await appendSent(db, messageId);
    const events: MailboxEvent[] = [];
    const bus = createInMemoryMailboxEventBus();
    bus.subscribe(SCOPE, (event) => void events.push(event));
    const deliver = createMailboxDeliver({ app: hubAnswering(409, { error: { code: "workflow_run_terminal" } }), persistMail: async () => [], db, bus });

    const failure = await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId });
    expect(failure?.message).toContain("answered 409");
    expect(await folderIds(db, "Sent")).toEqual([]);
    expect(await folderIds(db, "Trash")).toEqual([messageId]);
    expect(events.map((event) => event.op)).toEqual(["trash", "create"]);
  });

  test("an accepted trigger leaves the Sent copy where it is", async () => {
    const messageId = "<delivered@ws.localhost>";
    const raw = await appendSent(db, messageId);
    const deliver = createMailboxDeliver({ app: hubAnswering(202, { runId: RUN }), persistMail: async () => [], db });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();
    expect(await folderIds(db, "Sent")).toEqual([messageId]);
    expect(await folderIds(db, "Trash")).toEqual([]);
  });

  // #62: the hub mints its own Message-ID for the mail it delivers to the
  // run; the reply names that one. It is recorded on the Sent copy as a flag
  // so a client can pair the reply with this request rather than by order.
  test("an accepted trigger records the hub's Message-ID on the Sent copy", async () => {
    const messageId = "<delivered@ws.localhost>";
    const raw = await appendSent(db, messageId);
    const deliver = createMailboxDeliver({ app: hubAnswering(202, { runId: RUN, address: RUN_ADDRESS, messageId: "<trigger-1@hub.localhost>" }), persistMail: async () => [], db });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect([...sent.messages[0]!.flags]).toEqual([`${TRIGGER_FLAG_PREFIX}<trigger-1@hub.localhost>`]);
  });

  test("an accepted trigger whose answer carries no Message-ID leaves the Sent copy unflagged", async () => {
    const messageId = "<delivered@ws.localhost>";
    const raw = await appendSent(db, messageId);
    const deliver = createMailboxDeliver({ app: hubAnswering(202, { runId: RUN }), persistMail: async () => [], db });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    expect([...sent.messages[0]!.flags]).toEqual([]);
  });

  test("forwards subject, In-Reply-To and References from the mailbox frame onto the trigger POST", async () => {
    const messageId = "<reply@ws.localhost>";
    const raw = buildMailFrame({
      from: "owner@ws.localhost",
      to: RUN_ADDRESS,
      subject: "Re: Draft",
      body: "Please review.",
      messageId,
      inReplyTo: "<root@hub.localhost>",
      references: ["<root@hub.localhost>"],
    });
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    sent.append(
      raw,
      {
        messageId,
        from: "owner@ws.localhost",
        to: [RUN_ADDRESS],
        subject: "Re: Draft",
        date: new Date(),
        inReplyTo: "<root@hub.localhost>",
        references: ["<root@hub.localhost>"],
        interchangeType: undefined,
        interchangeCorrelationId: undefined,
      },
      [],
    );
    await sent.settled;
    const posts: unknown[] = [];
    const deliver = createMailboxDeliver({
      app: {
        request: async (_path: string, init?: RequestInit) => {
          posts.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ runId: RUN }), { status: 202 });
        },
      },
      persistMail: async () => [],
      db,
    });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();
    expect(posts).toEqual([
      {
        content: "Please review.",
        subject: "Re: Draft",
        inReplyTo: "<root@hub.localhost>",
        references: ["<root@hub.localhost>"],
      },
    ]);
  });

  test("recording a trigger id on a copy that is not in Sent is a no-op", async () => {
    expect(await recordTriggerId(db, SCOPE, "<never-sent@ws.localhost>", "<t@hub.localhost>")).toBe(false);
  });

  test("withdrawing a copy that is not in Sent is a no-op", async () => {
    expect(await withdrawSentCopy(db, SCOPE, "<never-sent@ws.localhost>")).toBe(false);
  });
});
