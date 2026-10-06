import { describe, expect, test } from "bun:test";
import { readStageThread, resetStageMailCache, unescapeLiteralNewlines } from "./stage-mail.ts";

describe("unescapeLiteralNewlines", () => {
  test("a qwen-shaped reply with literal \\n instead of newlines is undone", () => {
    const reply =
      "## What I need from you\\n- Are appointments shared across multiple salons or restricted to a single location?\\n- What kind of notifications do you want for stylists (e.g., SMS, email)?";
    const fixed = unescapeLiteralNewlines(reply);
    expect(fixed).toBe(
      "## What I need from you\n- Are appointments shared across multiple salons or restricted to a single location?\n- What kind of notifications do you want for stylists (e.g., SMS, email)?",
    );
    expect(fixed).not.toContain("\\n");
  });

  test("also undoes literal \\t and escaped quotes in the same pass", () => {
    expect(unescapeLiteralNewlines('a\\tb\\nc says \\"hi\\"\\nd')).toBe('a\tb\nc says "hi"\nd');
  });

  test("ordinary markdown with real newlines is left alone", () => {
    const body = "## In short\n- Customers book online.\n- Stylists get alerted.";
    expect(unescapeLiteralNewlines(body)).toBe(body);
  });

  test("a single literal backslash-n inside otherwise normal prose is not treated as escaped JSON", () => {
    const body = "The regex uses \\n to mean newline, but the rest of this reply\nis normal prose\nwith real breaks.";
    expect(unescapeLiteralNewlines(body)).toBe(body);
  });

  test("inline HTML in a reply is untouched — unescaping is only about newlines, never markup", () => {
    const reply = "<ul>\\n<li data-testid=\\\"appointment-form\\\">Book now</li>\\n</ul>";
    const fixed = unescapeLiteralNewlines(reply);
    expect(fixed).toBe('<ul>\n<li data-testid="appointment-form">Book now</li>\n</ul>');
  });
});

// #777: a folder once read is kept; a later read fetches only what is newer.
describe("readStageThread caching", () => {
  const AGENT = "agent@sb-test.localhost";
  const mail = (uid: number, from: string, to: string, body: string) => ({
    uid,
    flags: [],
    envelope: { messageId: `<m${String(uid)}>`, from, to: [to], subject: `m${String(uid)}`, date: new Date(Date.UTC(2026, 9, 6, 0, 0, 0) + uid * 1000).toISOString(), references: [] },
    raw: btoa(`From: ${from}\nTo: ${to}\nContent-Type: text/plain\n\n${body}`),
  });
  function transportOf(folders: Record<string, { uid: number; flags: string[]; envelope: object; raw: string }[]>, log: string[]) {
    return {
      async fetch<T>(_method: string, path: string): Promise<T> {
        log.push(path);
        const url = new URL(`http://x${path}`);
        const folder = url.searchParams.get("folder") ?? "INBOX";
        const cursor = url.searchParams.get("cursor");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const all = [...(folders[folder] ?? [])].sort((a, b) => b.uid - a.uid).filter((m) => cursor === null || m.uid < Number(cursor));
        const page = all.slice(0, limit);
        const rest = all.length > limit;
        return { messages: page, ...(rest ? { nextCursor: String(page[page.length - 1]!.uid) } : {}) } as T;
      },
      subscribe() {
        return () => undefined;
      },
    };
  }

  test("the first read walks the folders; the next reads one page each and sees the new mail", async () => {
    resetStageMailCache();
    const inbox = Array.from({ length: 150 }, (_, i) => mail(i + 1, AGENT, "me@sb-test.localhost", `reply ${String(i + 1)}`));
    const folders = { INBOX: inbox, Sent: [mail(1, "me@sb-test.localhost", AGENT, "ask")] };
    const log: string[] = [];
    const first = await readStageThread("tnt_1", [AGENT], transportOf(folders, log) as never);
    expect(first).toHaveLength(151);
    expect(log.filter((path) => path.includes("folder=INBOX"))).toHaveLength(2);
    log.length = 0;
    folders.INBOX.push(mail(151, AGENT, "me@sb-test.localhost", "newest"));
    const second = await readStageThread("tnt_1", [AGENT], transportOf(folders, log) as never);
    expect(second).toHaveLength(152);
    expect(second.at(-1)?.body).toBe("newest");
    expect(log).toHaveLength(2);
  });

  test("only mail involving the stage agent is in the thread", async () => {
    resetStageMailCache();
    const folders = { INBOX: [mail(1, AGENT, "me@sb-test.localhost", "mine"), mail(2, "other@sb-test.localhost", "me@sb-test.localhost", "not mine")], Sent: [] };
    const thread = await readStageThread("tnt_1", [AGENT], transportOf(folders, []) as never);
    expect(thread.map((m) => m.body)).toEqual(["mine"]);
  });
});
