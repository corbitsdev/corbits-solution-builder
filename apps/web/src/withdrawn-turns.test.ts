import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./stage-mail.ts";
import { workspaceGuidance } from "./pages/workspace/guidance.ts";
import { applyWithdrawn, pairReplies, pendingTurn } from "./withdrawn-turns.ts";

const at = (offset: number) => new Date(Date.UTC(2026, 8, 19, 12, offset)).toISOString();
const person = (id: string, offset: number): ChatMessage => ({
  id,
  author: "me",
  body: `person ${id}`,
  at: at(offset),
});
const agent = (id: string, offset: number): ChatMessage => ({
  id,
  author: "agent",
  body: `agent ${id}`,
  at: at(offset),
});

/** A person turn the hub accepted, with the trigger id it recorded (#62). */
const trigger = (id: string, offset: number, triggerMessageId: string): ChatMessage => ({
  ...person(id, offset),
  triggerMessageId,
});
/** An agent reply that names the trigger it answers. */
const reply = (id: string, offset: number, inReplyTo: string): ChatMessage => ({
  ...agent(id, offset),
  inReplyTo,
});

describe("pairReplies", () => {
  // #62: the hub's trigger Message-ID on the Sent row, named by the reply's
  // In-Reply-To, is what pairs them; order is only the fallback.
  test("pairs a reply with the turn its In-Reply-To names, not the oldest queued one", () => {
    const messages = [
      trigger("m1", 0, "<t1@hub>"),
      trigger("m2", 1, "<t2@hub>"),
      reply("a2", 2, "<t2@hub>"),
    ];
    const { answeredBy, queue } = pairReplies(messages);
    expect(answeredBy.get("a2")).toBe("m2");
    expect(queue.map((message) => message.id)).toEqual(["m1"]);
  });

  test("a truncated thread still pairs by id: a reply to a turn that fell out of the window pairs with nothing", () => {
    // Sent was read back from a later cursor than INBOX: m1 is gone, its
    // reply is not. By order that reply would have been credited to m2.
    const messages = [reply("a1", 2, "<t1@hub>"), trigger("m2", 3, "<t2@hub>"), reply("a2", 4, "<t2@hub>")];
    const { answeredBy, queue } = pairReplies(messages);
    expect(answeredBy.get("a1")).toBeUndefined();
    expect(answeredBy.get("a2")).toBe("m2");
    expect(queue).toEqual([]);
  });

  test("turns sent before the trigger id was recorded still pair by order, around the id-paired ones", () => {
    const messages = [
      person("old1", 0),
      trigger("m2", 1, "<t2@hub>"),
      agent("legacy1", 2),
      reply("a2", 3, "<t2@hub>"),
      person("old3", 4),
      agent("legacy3", 5),
    ];
    const { answeredBy, queue } = pairReplies(messages);
    expect(answeredBy.get("legacy1")).toBe("old1");
    expect(answeredBy.get("a2")).toBe("m2");
    expect(answeredBy.get("legacy3")).toBe("old3");
    expect(queue).toEqual([]);
  });

  test("a reply whose In-Reply-To names nothing in the thread falls back on order", () => {
    const messages = [trigger("m1", 0, "<t1@hub>"), reply("a1", 1, "<elsewhere@hub>")];
    expect(pairReplies(messages).answeredBy.get("a1")).toBe("m1");
  });

  test("a second reply to the same trigger answers nothing by id and falls back on order", () => {
    const messages = [trigger("m1", 0, "<t1@hub>"), reply("a1", 1, "<t1@hub>"), reply("a1b", 2, "<t1@hub>")];
    const { answeredBy } = pairReplies(messages);
    expect(answeredBy.get("a1")).toBe("m1");
    expect(answeredBy.has("a1b")).toBe(false);
  });
});

describe("applyWithdrawn", () => {
  test("hides the reply that names a withdrawn turn even when another turn was queued first", () => {
    const messages = [trigger("m1", 0, "<t1@hub>"), trigger("m2", 1, "<t2@hub>"), reply("a2", 2, "<t2@hub>"), reply("a1", 3, "<t1@hub>")];
    const folded = applyWithdrawn(messages, new Set(["m1"]));
    expect(folded.map((message) => message.id)).toEqual(["m1", "m2", "a2"]);
  });

  test("hides the late answer to a withdrawn turn but shows the reply to the next one", () => {
    // m1 withdrawn, m2 sent before the specialist ever answers m1; its late
    // answer to m1 arrives first (FIFO), then it answers m2.
    const messages = [person("m1", 0), person("m2", 1), agent("a1", 2), agent("a2", 3)];
    const folded = applyWithdrawn(messages, new Set(["m1"]));
    expect(folded.map((message) => message.id)).toEqual(["m1", "m2", "a2"]);
  });

  test("never hides an agent message that arrives with nothing queued", () => {
    // The stage's opening reply, or an unsolicited message: nothing to pair
    // it against, so it is never hidden regardless of what is withdrawn.
    const messages = [agent("opening", 0), person("m1", 1)];
    const folded = applyWithdrawn(messages, new Set(["m1"]));
    expect(folded.map((message) => message.id)).toEqual(["opening", "m1"]);
  });

  test("hides both replies when two turns in a row are withdrawn", () => {
    const messages = [person("m1", 0), person("m2", 1), agent("a1", 2), agent("a2", 3)];
    const folded = applyWithdrawn(messages, new Set(["m1", "m2"]));
    expect(folded.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  test("is a no-op when nothing is withdrawn", () => {
    const messages = [person("m1", 0), agent("a1", 1)];
    expect(applyWithdrawn(messages, new Set())).toEqual(messages);
  });

  test("guidance takes its draft and question only from a visible reply", () => {
    const completeDraft = [
      "# Problem statement",
      "A support team loses hours finding the latest customer context across separate systems. The immediate pain is that a person must copy information from three places before responding, which delays customers and creates inconsistent answers.",
      "",
      "## Success criteria",
      "A teammate can find the current context in one place, understand what is missing, and verify the response path with a representative case. The initial release should make the workflow observable without assuming a particular technical solution.",
    ].join("\n");
    const messages: ChatMessage[] = [
      { id: "m1", author: "me", body: "Build a CRM", at: at(0) },
      { id: "a1", author: "agent", body: completeDraft, at: at(1) },
      { id: "m2", author: "me", body: "Actually, hold on", at: at(2) },
    ];
    // The specialist answers m2 with a substantial draft the person stopped
    // before reading; it must never surface as the draft or its question.
    const lateAnswer = agent("a2", 3);
    const withdrawn = new Set(["m2"]);
    const folded = applyWithdrawn([...messages, lateAnswer], withdrawn);
    const guidance = workspaceGuidance(1, folded);
    expect(guidance.draft?.id).toBe("a1");
    expect(folded.some((message) => message.id === "a2")).toBe(false);
  });
});

describe("pendingTurn", () => {
  test("is the last message when it is an unanswered person turn", () => {
    const messages = [person("m1", 0), agent("a1", 1), person("m2", 2)];
    expect(pendingTurn(messages, new Set())?.id).toBe("m2");
  });

  test("is the oldest unanswered turn when more than one is queued", () => {
    const messages = [person("m1", 0), person("m2", 1)];
    expect(pendingTurn(messages, new Set())?.id).toBe("m1");
  });

  test("is null once the specialist has answered", () => {
    const messages = [person("m1", 0), agent("a1", 1)];
    expect(pendingTurn(messages, new Set())).toBeNull();
  });

  test("is null when nothing is pending", () => {
    expect(pendingTurn([], new Set())).toBeNull();
  });

  test("is null for a turn already withdrawn", () => {
    const messages = [person("m1", 0)];
    expect(pendingTurn(messages, new Set(["m1"]))).toBeNull();
  });
});
