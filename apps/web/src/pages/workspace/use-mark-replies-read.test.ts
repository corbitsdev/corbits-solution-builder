import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import { repliesToMarkRead } from "./use-mark-replies-read.ts";

function reply(id: string, overrides: Partial<{ -readonly [K in keyof ChatMessage]: ChatMessage[K] | undefined }> = {}): ChatMessage {
  const message = { id, author: "agent", body: "hello", at: "2026-10-09T12:00:00.000Z", unread: true, mailTenantId: "tnt_project", ...overrides };
  return JSON.parse(JSON.stringify(message)) as ChatMessage;
}

describe("repliesToMarkRead", () => {
  test("only unread agent replies with a known mailbox, by uid", () => {
    const messages: ChatMessage[] = [
      reply("INBOX:7"),
      reply("INBOX:8", { unread: false }),
      reply("INBOX:9", { mailTenantId: undefined }),
      reply("Sent:3", { author: "me", unread: undefined, mailTenantId: undefined }),
      reply("INBOX:10", { mailTenantId: "tnt_workspace" }),
    ];
    expect(repliesToMarkRead(messages)).toEqual([
      { id: "INBOX:7", mailTenantId: "tnt_project", uid: 7 },
      { id: "INBOX:10", mailTenantId: "tnt_workspace", uid: 10 },
    ]);
  });

  test("skips replies already marked or in flight", () => {
    expect(repliesToMarkRead([reply("INBOX:7"), reply("INBOX:8")], new Set(["INBOX:7"]))).toEqual([
      { id: "INBOX:8", mailTenantId: "tnt_project", uid: 8 },
    ]);
  });

  test("an id that names no uid is left alone", () => {
    expect(repliesToMarkRead([reply("INBOX:reconnected"), reply("INBOX:0")])).toEqual([]);
  });
});
