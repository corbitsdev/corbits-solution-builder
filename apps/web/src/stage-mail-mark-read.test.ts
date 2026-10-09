import { afterEach, describe, expect, test } from "bun:test";
import { markStageMailRead, readStageThread, resetStageMailCache, SEEN_FLAG } from "./stage-mail.ts";

const AGENT = "run_a1b2c3d4e5f60718293a4b5c6d7e8f90@sb-project.localhost";
const ME = "owner@ws.localhost";

function frame(from: string, to: string, body: string): string {
  return btoa(`From: ${from}\r\nTo: ${to}\r\nSubject: x\r\n\r\n${body}`);
}

type Row = {
  uid: number;
  flags: string[];
  envelope: { messageId: string; from: string; to: string[]; subject: string; date: string; references: string[] };
  raw: string;
};

const at = (offset: number) => new Date(Date.UTC(2026, 9, 9, 12, offset)).toISOString();

function sentRow(uid: number): Row {
  return {
    uid,
    flags: [],
    envelope: { messageId: `<s${String(uid)}@ws>`, from: ME, to: [AGENT], subject: "x", date: at(uid), references: [] },
    raw: frame(ME, AGENT, `person ${String(uid)}`),
  };
}

function inboxRow(uid: number, flags: string[] = []): Row {
  return {
    uid,
    flags,
    envelope: { messageId: `<i${String(uid)}@run>`, from: AGENT, to: [ME], subject: "x", date: at(uid), references: [] },
    raw: frame(AGENT, ME, `agent ${String(uid)}`),
  };
}

/** A hub mailbox: the list route per folder, plus the `read` verb. */
function mockMailbox(folders: Record<string, Row[]>) {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = new URL(String(url), "http://hub");
    requests.push(`${init?.method ?? "GET"} ${href.pathname}${href.search}`);
    const read = /\/inbox\/(\d+)\/read$/.exec(href.pathname);
    if (read) {
      const row = (folders["INBOX"] ?? []).find((entry) => entry.uid === Number(read[1]));
      if (!row) return new Response(JSON.stringify({ error: "Message not found" }), { status: 404 });
      row.flags.push(SEEN_FLAG);
      return new Response(JSON.stringify({ uid: row.uid, ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const folder = href.searchParams.get("folder") ?? "INBOX";
    const messages = [...(folders[folder] ?? [])].sort((a, b) => b.uid - a.uid);
    return new Response(JSON.stringify({ messages }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return requests;
}

describe("readStageThread's read state", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    resetStageMailCache();
  });

  test("an agent reply says whether it is unread and which mailbox holds it; a person turn says neither", async () => {
    mockMailbox({ Sent: [sentRow(1)], INBOX: [inboxRow(2), inboxRow(3, [SEEN_FLAG])] });
    const thread = await readStageThread("tnt_project", [AGENT]);
    expect(thread.map((message) => [message.id, message.unread, message.mailTenantId])).toEqual([
      ["Sent:1", undefined, undefined],
      ["INBOX:2", true, "tnt_project"],
      ["INBOX:3", false, "tnt_project"],
    ]);
  });

  test("marking a reply read posts the verb and flags the cached copy, so the next read sees it read without re-asking the hub", async () => {
    const requests = mockMailbox({ Sent: [], INBOX: [inboxRow(2)] });
    expect((await readStageThread("tnt_project", [AGENT])).map((message) => message.unread)).toEqual([true]);
    await markStageMailRead("tnt_project", 2);
    expect(requests).toContain("POST /api/tenants/tnt_project/mailbox/me/inbox/2/read");
    const listReads = requests.filter((request) => request.includes("folder=INBOX")).length;
    expect((await readStageThread("tnt_project", [AGENT])).map((message) => message.unread)).toEqual([false]);
    // One more page read for newer mail (#777); the held row is not fetched again.
    expect(requests.filter((request) => request.includes("folder=INBOX")).length).toBe(listReads + 1);
  });

  test("a refused mark is thrown, never swallowed", async () => {
    mockMailbox({ Sent: [], INBOX: [] });
    await expect(markStageMailRead("tnt_project", 9)).rejects.toThrow();
  });
});
