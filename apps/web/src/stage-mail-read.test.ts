import { afterEach, describe, expect, test } from "bun:test";
import { readStageThread, sendStageMail, TRIGGER_FLAG_PREFIX } from "./stage-mail.ts";

const AGENT = "run_a1b2c3d4e5f60718293a4b5c6d7e8f90@sb-project.localhost";
const ME = "owner@ws.localhost";

function frame(from: string, to: string, body: string): string {
  return btoa(`From: ${from}\r\nTo: ${to}\r\nSubject: x\r\n\r\n${body}`);
}

type Row = {
  uid: number;
  flags: string[];
  envelope: { messageId: string; from: string; to: string[]; subject: string; date: string; inReplyTo?: string; references: string[] };
  raw: string;
};

const at = (offset: number) => new Date(Date.UTC(2026, 8, 19, 12, offset)).toISOString();

function sentRow(uid: number, triggerId?: string): Row {
  return {
    uid,
    flags: triggerId === undefined ? [] : [`${TRIGGER_FLAG_PREFIX}${triggerId}`],
    envelope: { messageId: `<s${String(uid)}@ws>`, from: ME, to: [AGENT], subject: "x", date: at(uid), references: [] },
    raw: frame(ME, AGENT, `person ${String(uid)}`),
  };
}

function inboxRow(uid: number, inReplyTo?: string): Row {
  return {
    uid,
    flags: [],
    envelope: { messageId: `<i${String(uid)}@run>`, from: AGENT, to: [ME], subject: "x", date: at(uid), ...(inReplyTo === undefined ? {} : { inReplyTo }), references: [] },
    raw: frame(AGENT, ME, `agent ${String(uid)}`),
  };
}

/** A hub mailbox list route: newest first, `limit` per page, `nextCursor` the last uid while more remain. */
function mockMailbox(folders: Record<string, Row[]>) {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = new URL(String(url), "http://hub");
    requests.push(`${href.pathname}${href.search}`);
    const folder = href.searchParams.get("folder") ?? "INBOX";
    const limit = Number(href.searchParams.get("limit") ?? "100");
    const cursor = href.searchParams.get("cursor");
    const all = [...(folders[folder] ?? [])].sort((a, b) => b.uid - a.uid);
    const from = cursor === null ? 0 : all.findIndex((row) => row.uid === Number(cursor)) + 1;
    const page = all.slice(from, from + limit);
    const body: { messages: Row[]; nextCursor?: string } = { messages: page };
    if (from + limit < all.length) body.nextCursor = String(page[page.length - 1]!.uid);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return requests;
}

describe("readStageThread", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  // #62: one page of 100 was the whole read once, so a long thread lost its
  // oldest turns from whichever folder had more traffic.
  test("follows nextCursor until a folder is read to its end", async () => {
    const sent = Array.from({ length: 250 }, (_, index) => sentRow(index + 1));
    const requests = mockMailbox({ Sent: sent, INBOX: [inboxRow(1000)] });
    const thread = await readStageThread("tnt_ws", [AGENT]);
    expect(thread.filter((message) => message.author === "me")).toHaveLength(250);
    expect(thread.filter((message) => message.author === "agent")).toHaveLength(1);
    const sentReads = requests.filter((request) => request.includes("folder=Sent"));
    expect(sentReads).toHaveLength(3);
    expect(sentReads[1]).toContain("cursor=151");
    expect(sentReads[2]).toContain("cursor=51");
  });

  test("carries the hub's trigger id from a Sent row's flags, and a reply's In-Reply-To", async () => {
    mockMailbox({ Sent: [sentRow(1, "<t1@hub>"), sentRow(2)], INBOX: [inboxRow(3, "<t1@hub>")] });
    const thread = await readStageThread("tnt_ws", [AGENT]);
    expect(thread.map((message) => [message.id, message.triggerMessageId, message.inReplyTo])).toEqual([
      ["Sent:1", "<t1@hub>", undefined],
      ["Sent:2", undefined, undefined],
      ["INBOX:3", undefined, "<t1@hub>"],
    ]);
  });
});

describe("sendStageMail", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  function captureSend(folders: Record<string, Row[]>): unknown[] {
    mockMailbox(folders);
    const list = globalThis.fetch;
    const posts: unknown[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posts.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return list(url, init);
    }) as typeof fetch;
    return posts;
  }

  test("threads onto the first person turn that has a trigger id, skipping an unflagged opening", async () => {
    const posts = captureSend({ Sent: [sentRow(1), sentRow(2, "<t2@hub>")], INBOX: [] });
    await sendStageMail("tnt_ws", AGENT, { body: "next" });
    expect(posts).toEqual([{ to: [AGENT], subject: "next", body: "next", inReplyTo: "<t2@hub>" }]);
  });

  test("keeps the first trigger id even when a later person turn has a newer one", async () => {
    const posts = captureSend({ Sent: [sentRow(1, "<t1@hub>"), sentRow(2, "<t2@hub>")], INBOX: [] });
    await sendStageMail("tnt_ws", AGENT, { body: "next" });
    expect(posts).toEqual([{ to: [AGENT], subject: "next", body: "next", inReplyTo: "<t1@hub>" }]);
  });

  test("sends unthreaded when no person turn has a trigger id", async () => {
    const posts = captureSend({ Sent: [sentRow(1)], INBOX: [] });
    await sendStageMail("tnt_ws", AGENT, { body: "next" });
    expect(posts).toEqual([{ to: [AGENT], subject: "next", body: "next" }]);
  });
});
