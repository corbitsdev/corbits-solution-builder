import { describe, expect, test } from "bun:test";
import { packageReplyFor } from "./package-reply.ts";
import { appSubject } from "./pages/workspace/composed-mail.ts";
import type { ChatMessage } from "./stage-mail.ts";

const at = (minute: number) => `2026-09-28T10:${String(minute).padStart(2, "0")}:00.000Z`;

function me(id: string, body: string, minute: number, triggerMessageId?: string): ChatMessage {
  return { id, author: "me", body, at: at(minute), ...(triggerMessageId ? { triggerMessageId } : {}) };
}

function ask(id: string, name: string, minute: number, triggerMessageId?: string): ChatMessage {
  return { ...me(id, "", minute, triggerMessageId), subject: appSubject("package", name) };
}

function agent(id: string, body: string, minute: number, inReplyTo?: string): ChatMessage {
  return { id, author: "agent", body, at: at(minute), ...(inReplyTo ? { inReplyTo } : {}) };
}

// #41 step 3: one stage 5 deployment answers every stakeholder's request on
// the one thread, so each request's reply is found by pairing, not by being
// the next agent turn.
describe("packageReplyFor", () => {
  const opening = me("Sent:1", "[opening] the approved design", 0, "<t-opening>");
  const ack = agent("INBOX:1", "Noted. Name an audience and I will write their package.", 1, "<t-opening>");
  const seen = new Set([opening.id, ack.id]);
  const financeAsk = ask("Sent:2", "Finance", 2, "<t-finance>");
  const securityAsk = ask("Sent:3", "Security", 2, "<t-security>");

  test("null until the request is on the thread, and until it has a reply", () => {
    expect(packageReplyFor([opening, ack], seen, "Finance")).toBeNull();
    expect(packageReplyFor([opening, ack, financeAsk], seen, "Finance")).toBeNull();
  });

  test("two requests in flight each get their own reply, by trigger id, whatever the order the replies land in", () => {
    const securityReply = agent("INBOX:2", "## Audience: Security", 5, "<t-security>");
    const financeReply = agent("INBOX:3", "## Audience: Finance", 6, "<t-finance>");
    const thread = [opening, ack, financeAsk, securityAsk, securityReply, financeReply];
    expect(packageReplyFor(thread, seen, "Finance")).toBe(financeReply);
    expect(packageReplyFor(thread, seen, "Security")).toBe(securityReply);
  });

  test("falls back on order when the hub recorded no trigger id", () => {
    const financeAskNoId = ask("Sent:2", "Finance", 2);
    const securityAskNoId = ask("Sent:3", "Security", 3);
    const first = agent("INBOX:2", "## Audience: Finance", 5);
    const second = agent("INBOX:3", "## Audience: Security", 6);
    const thread = [opening, ack, financeAskNoId, securityAskNoId, first, second];
    expect(packageReplyFor(thread, seen, "Finance")).toBe(first);
    expect(packageReplyFor(thread, seen, "Security")).toBe(second);
  });

  test("a request for the same stakeholder written earlier is not this one", () => {
    const earlierAsk = ask("Sent:2", "Finance", 2, "<t-earlier>");
    const earlierReply = agent("INBOX:2", "## Audience: Finance (v1)", 3, "<t-earlier>");
    const seenNow = new Set([opening.id, ack.id, earlierAsk.id, earlierReply.id]);
    const againAsk = ask("Sent:3", "Finance", 4, "<t-again>");
    const thread = [opening, ack, earlierAsk, earlierReply, againAsk];
    expect(packageReplyFor(thread, seenNow, "Finance")).toBeNull();
    const againReply = agent("INBOX:3", "## Audience: Finance (v2)", 7, "<t-again>");
    expect(packageReplyFor([...thread, againReply], seenNow, "Finance")).toBe(againReply);
  });
});
