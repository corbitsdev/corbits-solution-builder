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
import { captureMailboxRequest, createMailboxDeliver, recordTriggerId, takeAttachMarkers, TRIGGER_FLAG_PREFIX, withdrawSentCopy } from "./mailbox-send.js";
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

  test("recording a trigger id on a copy that is not in Sent is a no-op", async () => {
    expect(await recordTriggerId(db, SCOPE, "<never-sent@ws.localhost>", "<t@hub.localhost>")).toBe(false);
  });

  test("withdrawing a copy that is not in Sent is a no-op", async () => {
    expect(await withdrawSentCopy(db, SCOPE, "<never-sent@ws.localhost>")).toBe(false);
  });
});

describe("takeAttachMarkers (#915)", () => {
  test("takes every marker out of the text and names each artifact once, in order", () => {
    const { text, artifactIds } = takeAttachMarkers("--- MATERIAL: shot.png ---\n(A picture.) [attach:art_1]\n\nMore. [attach:art_2] [attach:art_1]");
    expect(text).toBe("--- MATERIAL: shot.png ---\n(A picture.)\n\nMore.");
    expect(artifactIds).toEqual(["art_1", "art_2"]);
  });

  test("text without a marker is returned as it is", () => {
    expect(takeAttachMarkers("Please review.")).toEqual({ text: "Please review.", artifactIds: [] });
  });
});

// #915: the mailbox send route carries text only, so a picture rides as an
// `[attach:<artifact id>]` marker in the body; the bridge reads the file off
// the artifacts download route under the caller's own session and hands it
// to the trigger as an attachment, with the marker taken out of the text.
describe("createMailboxDeliver, attached pictures (#915)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const BODY = "--- MATERIAL THE PERSON PROVIDED: shot.png ---\n(A picture, image/png, attached to this message for you to look at.) [attach:art_shot]";
  let db: MailboxDb;
  beforeEach(async () => {
    db = await openDb();
  });

  async function sentFrame(messageId: string, body: string): Promise<Uint8Array> {
    const raw = buildMailFrame({ from: "owner@ws.localhost", to: RUN_ADDRESS, subject: "Opening", body, messageId });
    const sent = await openNativeMailboxStore(db, { ...SCOPE, folder: "Sent" });
    sent.append(
      raw,
      { messageId, from: "owner@ws.localhost", to: [RUN_ADDRESS], subject: "Opening", date: new Date(), inReplyTo: undefined, references: [], interchangeType: undefined, interchangeCorrelationId: undefined },
      [],
    );
    await sent.settled;
    return raw;
  }

  /** A hub whose artifacts download route serves `files` and whose trigger route records what it was posted. */
  function hubServing(files: Record<string, { type: string; bytes: Uint8Array; disposition?: string } | number>) {
    const posted: { path: string; headers: Headers; body: unknown }[] = [];
    const gets: { path: string; headers: Headers }[] = [];
    const app = {
      request: async (input: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (init?.method === "GET") {
          gets.push({ path: input, headers });
          const id = /\/artifacts\/([^/]+)\/download$/.exec(input)?.[1];
          const file = id === undefined ? undefined : files[decodeURIComponent(id)];
          if (file === undefined) return new Response(JSON.stringify({ error: "Artifact not found" }), { status: 404 });
          if (typeof file === "number") return new Response("", { status: file });
          return new Response(file.bytes.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: { "content-type": file.type, "content-disposition": file.disposition ?? 'attachment; filename="shot.png"' },
          });
        }
        posted.push({ path: input, headers, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ runId: RUN, address: RUN_ADDRESS, messageId: "<trigger-1@hub.localhost>" }), { status: 202 });
      },
    };
    return { app, posted, gets };
  }

  test("a marked picture is read off the download route under the caller's session and rides as a trigger attachment", async () => {
    const messageId = "<with-picture@ws.localhost>";
    const raw = await sentFrame(messageId, BODY);
    const hub = hubServing({ art_shot: { type: "image/png", bytes: PNG } });
    const deliver = createMailboxDeliver({ app: hub.app, persistMail: async () => [], db });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();

    expect(hub.gets.map((get) => get.path)).toEqual([`/api/tenants/${SCOPE.tenantId}/artifacts/art_shot/download`]);
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]!.body).toEqual({
      content: "--- MATERIAL THE PERSON PROVIDED: shot.png ---\r\n(A picture, image/png, attached to this message for you to look at.)",
      attachments: [{ mimeType: "image/png", data: Buffer.from(PNG).toString("base64"), name: "shot.png" }],
    });
    expect(await folderIds(db, "Sent")).toEqual([messageId]);
  });

  test("the picture's name comes from the download's disposition, RFC 5987 form included, and never carries a quote", async () => {
    const messageId = "<named@ws.localhost>";
    const raw = await sentFrame(messageId, BODY);
    const hub = hubServing({ art_shot: { type: "image/png", bytes: PNG, disposition: "attachment; filename*=UTF-8''Screenshot%202026-10-26%20at%207.17.57%E2%80%AFAM.png" } });
    const deliver = createMailboxDeliver({ app: hub.app, persistMail: async () => [], db });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();
    const [attachment] = (hub.posted[0]!.body as { attachments: { name: string }[] }).attachments;
    expect(attachment!.name).toBe("Screenshot 2026-10-26 at 7.17.57 AM.png");
  });

  test("a mail naming no picture is posted as before, with no attachments field", async () => {
    const messageId = "<plain@ws.localhost>";
    const raw = await sentFrame(messageId, "Please review.");
    const hub = hubServing({});
    const deliver = createMailboxDeliver({ app: hub.app, persistMail: async () => [], db });
    expect(await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId })).toBeNull();
    expect(hub.gets).toEqual([]);
    expect(hub.posted[0]!.body).toEqual({ content: "Please review." });
  });

  test("a picture that cannot be read fails the send before the run is triggered, and takes the Sent copy back", async () => {
    const messageId = "<missing@ws.localhost>";
    const raw = await sentFrame(messageId, BODY);
    const hub = hubServing({});
    const deliver = createMailboxDeliver({ app: hub.app, persistMail: async () => [], db });
    const failure = await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId });
    expect(failure?.message).toContain("art_shot could not be read to attach it (404)");
    expect(hub.posted).toEqual([]);
    expect(await folderIds(db, "Sent")).toEqual([]);
    expect(await folderIds(db, "Trash")).toEqual([messageId]);
  });

  test("a marked file that is not a picture a specialist can be shown fails the send rather than riding or being left out", async () => {
    const messageId = "<not-a-picture@ws.localhost>";
    const raw = await sentFrame(messageId, BODY);
    const hub = hubServing({ art_shot: { type: "application/pdf", bytes: PNG } });
    const deliver = createMailboxDeliver({ app: hub.app, persistMail: async () => [], db });
    const failure = await deliverUnderRequest(deliver, { raw, from: "owner@ws.localhost", to: [RUN_ADDRESS], messageId });
    expect(failure?.message).toContain("is application/pdf, not a picture");
    expect(hub.posted).toEqual([]);
    expect(await folderIds(db, "Trash")).toEqual([messageId]);
  });
});
