import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import {
  HANDOFF_BUBBLE_TEXT,
  HANDOFF_CLOSE,
  MAX_HANDOFF_CHARS,
  handoffMarkerOf,
  composeModelHandoff,
  conversationTurns,
  isHandoffMessage,
  handoffDue,
  handoffId,
  handoffLanded,
  handoffPending,
  switchMarker,
} from "./use-model-handoff.ts";
import { withoutSwitchMarker } from "./thread.tsx";

const at = "2026-09-26T08:26:22.000Z";
const head: ChatMessage = { id: "opening", author: "me", body: "## In short\n- The deliverable is an iPhone application called Workout Log.", at };
const OLD = "run_b69ee3b5@solutions-builder.localhost";
const NEW = "run_73558600@solutions-builder.localhost";

describe("handoffDue", () => {
  test("a redeployed stage with prior mail and a loaded thread is due", () => {
    expect(handoffDue({ address: NEW, addresses: [OLD, NEW], threadLoaded: true, priorHead: head })).toBe(true);
  });

  test("not before the thread has loaded for the live address, however the other inputs arrived (#82)", () => {
    expect(handoffDue({ address: NEW, addresses: [OLD, NEW], threadLoaded: false, priorHead: null })).toBe(false);
    expect(handoffDue({ address: NEW, addresses: [OLD, NEW], threadLoaded: false, priorHead: head })).toBe(false);
  });

  test("a brand-new stage, or no live address yet, is the opening's job", () => {
    expect(handoffDue({ address: NEW, addresses: [NEW], threadLoaded: true, priorHead: head })).toBe(false);
    expect(handoffDue({ address: NEW, addresses: [], threadLoaded: true, priorHead: head })).toBe(false);
    expect(handoffDue({ address: null, addresses: [OLD, NEW], threadLoaded: true, priorHead: head })).toBe(false);
  });

  test("a loaded but empty transcript has nothing to hand off", () => {
    expect(handoffDue({ address: NEW, addresses: [OLD, NEW], threadLoaded: true, priorHead: null })).toBe(false);
  });
});

describe("composeModelHandoff", () => {
  const mockup = `<!doctype html>\n<html lang="en"><head><style>body{margin:0}</style></head><body>${"<section data-testid=\"screen-phone\">Workout Log</section>".repeat(8)}</body></html>`;
  const messages: ChatMessage[] = [
    head,
    { id: "err", author: "agent", body: "This agent could not complete your request due to an unrecoverable inference error [HTTP 404]: Not found", at },
    { id: "ask", author: "me", body: "I want to see a gui design", at },
    { id: "design", author: "agent", body: mockup, at },
  ];

  test("names a design reply in the recap instead of quoting the document, and the draft block carries it once (#85)", () => {
    const mail = composeModelHandoff({ id: "abc123", messages, draft: messages[3]!, providerLabel: "OpenAI", modelName: "gpt-5.5" });
    const recap = mail.slice(0, mail.indexOf("The current draft:"));
    expect(recap).toContain("Specialist: (sent a design mockup");
    expect(recap).not.toContain("<!doctype html>");
    expect(recap).toContain("Person: I want to see a gui design");
    expect(mail.split("<!doctype html>").length - 1).toBe(1);
    expect(mail.startsWith(switchMarker("abc123"))).toBe(true);
    expect(mail).toContain("This stage continues on OpenAI · gpt-5.5.");
  });
});

// #115: the stage's opening is its input, and rides along whole even when it
// is an HTML document; a design reply is still only named.
describe("composeModelHandoff keeps the opening", () => {
  const design = "<!doctype html><html><body><section data-testid=\"screen-capture\">Capture</section></body></html>";
  const opening: ChatMessage = { id: "opening-design", author: "me", body: design, at };
  const ask: ChatMessage = { id: "ask", author: "me", body: "Write the package for: Mr Finance.", at };
  const reply: ChatMessage = { id: "reply", author: "agent", body: design, at };

  test("quotes an HTML opening in full and names a design reply", () => {
    const body = composeModelHandoff({ id: "a1", messages: [opening, ask, reply], draft: null, providerLabel: null, modelName: null });
    expect(body).toContain(`Person: ${design}`);
    expect(body).toContain("Specialist: (sent a design mockup as a whole HTML document");
  });

  test("keeps the opening ahead of the condensed turns", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, author: i % 2 ? "agent" : "me", body: `turn ${i}`, at }) as ChatMessage);
    const body = composeModelHandoff({ id: "a2", messages: [opening, ...many], draft: null, providerLabel: null, modelName: null });
    const recap = body.slice(body.indexOf("Here is the conversation so far"));
    expect(recap.indexOf(`Person: ${design}`)).toBeLessThan(recap.indexOf("earlier turn"));
    expect(recap).toContain("(11 earlier turns omitted.)");
    expect(recap).toContain("turn 29");
    expect(recap).not.toContain("turn 5\n");
  });
});

// #305: a hand-off is plumbing, not a turn. Quoting an earlier one nested its
// recap inside this one, and a stage redeployed 227 times handed its
// specialist 24 MB.
describe("composeModelHandoff leaves earlier hand-offs out and keeps the recap bounded", () => {
  const design = `<!doctype html><html><body>${"<section data-testid=\"screen-gantt\">Gantt</section>".repeat(40)}</body></html>`;
  const opening: ChatMessage = { id: "opening-design", author: "me", body: design, at };
  const ask: ChatMessage = { id: "ask", author: "me", body: "Write the package for: Mr Finance.", at };
  const reply: ChatMessage = { id: "reply", author: "agent", body: "## Package\n\n### Deck outline\n1. Why now", at };

  test("a recap composed against a transcript holding a hand-off quotes the conversation, not the hand-off", () => {
    const first = composeModelHandoff({ id: "ab1", messages: [opening, ask, reply], draft: reply, providerLabel: null, modelName: null });
    const handoff: ChatMessage = { id: "handoff-1", author: "me", body: first, at };
    const later: ChatMessage = { id: "ask-2", author: "me", body: "Put the Gantt chart on the 'What it looks like' slide", at };
    const second = composeModelHandoff({ id: "ab2", messages: [opening, ask, reply, handoff, later], draft: reply, providerLabel: null, modelName: null });
    expect(second.split("Here is the conversation so far").length - 1).toBe(1);
    expect(second.split("[[sb-switch:").length - 1).toBe(1);
    expect(second.split("<!doctype html>").length - 1).toBe(1);
    expect(second).toContain(`Person: ${later.body}`);
    expect(second).toContain("Person: Write the package for: Mr Finance.");
    expect(second).not.toContain("Person: [[sb-switch:");
    expect(isHandoffMessage(handoff)).toBe(true);
    expect(isHandoffMessage(later)).toBe(false);
    expect(isHandoffMessage({ author: "agent", body: first })).toBe(false);
    expect(conversationTurns([opening, ask, reply, handoff, later]).map((m) => m.id)).toEqual(["opening-design", "ask", "reply", "ask-2"]);
  });

  test("two hundred redeploys later the recap is the same size as after one", () => {
    let messages: ChatMessage[] = [opening, ask, reply];
    let recap = "";
    for (let i = 0; i < 200; i += 1) {
      const body = composeModelHandoff({ id: `a${String(i)}`, messages, draft: reply, providerLabel: "Anthropic", modelName: "claude-fable-5-1" });
      const past = body.slice(body.indexOf("\n") + 1);
      if (i === 0) recap = past;
      expect(past).toBe(recap);
      messages = [...messages, { id: `handoff-${String(i)}`, author: "me", body, at }];
    }
  });

  test("long turns are dropped oldest first until the recap fits the character budget, and the count says so", () => {
    const long = (i: number): ChatMessage => ({ id: `long-${String(i)}`, author: i % 2 ? "agent" : "me", body: `turn ${String(i)} ${"x".repeat(60_000)}`, at });
    const turns = Array.from({ length: 10 }, (_, i) => long(i));
    const body = composeModelHandoff({ id: "ab3", messages: [opening, ...turns], draft: null, providerLabel: null, modelName: null });
    expect(body.length).toBeLessThan(MAX_HANDOFF_CHARS + design.length + 2_000);
    expect(body).toContain("(7 earlier turns omitted.)");
    expect(body).toContain("turn 9 ");
    expect(body).toContain("turn 7 ");
    expect(body).not.toContain("turn 6 ");
    expect(body).toContain(`Person: ${design}`);
  });
});

describe("withoutSwitchMarker", () => {
  test("a hand-off mail reads as one line in the bubble, never as its recap (#85)", () => {
    const body = `${switchMarker("abc123")}\nThis stage continues on OpenAI · gpt-5.5.\n\n---\n\nHere is the conversation so far:\n\nSpecialist: <!doctype html><html></html>`;
    expect(withoutSwitchMarker({ id: "h", author: "me", body, at })).toBe(HANDOFF_BUBBLE_TEXT);
  });

  test("an ordinary person's message, and anything a specialist writes, is untouched", () => {
    expect(withoutSwitchMarker({ id: "p", author: "me", body: "Make it blue", at })).toBe("Make it blue");
    const echoed = `${switchMarker("abc123")}\nnot a hand-off`;
    expect(withoutSwitchMarker({ id: "s", author: "agent", body: echoed, at })).toBe(echoed);
  });
});

// #105: a send-back cue must never be the first mail a redeployed specialist
// gets -- the hand-off is, and the cue waits until it has landed.
describe("handoffLanded and handoffPending", () => {
  const reply: ChatMessage = { id: "reply-1", author: "agent", body: "<!doctype html><html></html>", at };
  const handoff: ChatMessage = {
    id: "handoff-1",
    author: "me",
    body: `${switchMarker(handoffId(NEW, reply.id))}\nThis stage continues on Anthropic · claude-fable-5-1.\n\n---\n\nHere is the conversation so far`,
    at,
  };

  test("a hand-off is landed when a person's marker names this address and an earlier head", () => {
    expect(handoffLanded(NEW, [head, reply, handoff])).toBe(true);
    expect(handoffLanded(NEW, [head, reply])).toBe(false);
  });

  test("a hand-off to some other address, or a specialist quoting a marker, is not this one", () => {
    const other: ChatMessage = { ...handoff, id: "handoff-x", body: `${switchMarker(handoffId(OLD, reply.id))}\nThis stage continues.` };
    const quoted: ChatMessage = { ...handoff, id: "quoted", author: "agent" };
    expect(handoffLanded(NEW, [head, reply, other])).toBe(false);
    expect(handoffLanded(NEW, [head, reply, quoted])).toBe(false);
  });

  test("the cue waits while a redeployed address is owed a hand-off, and goes once it has landed", () => {
    expect(handoffPending({ address: NEW, addresses: [OLD, NEW], threadLoaded: true, messages: [head, reply] })).toBe(true);
    expect(handoffPending({ address: NEW, addresses: [OLD, NEW], threadLoaded: true, messages: [head, reply, handoff] })).toBe(false);
  });

  test("nothing waits on a stage that was never redeployed, or before the thread has loaded", () => {
    expect(handoffPending({ address: NEW, addresses: [NEW], threadLoaded: true, messages: [head, reply] })).toBe(false);
    expect(handoffPending({ address: NEW, addresses: [OLD, NEW], threadLoaded: false, messages: [head, reply] })).toBe(false);
  });
});

// #327: the hand-off asks for nothing, so the new specialist does not answer
// it with a whole new draft; and a hand-off is recognised however the mail
// store hands its body back.
describe("the hand-off's close and its recognition", () => {
  test("the mail ends by asking for a one-line acknowledgement and no redraft", () => {
    const mail = composeModelHandoff({ id: "abc1", messages: [head], draft: null, providerLabel: null, modelName: null });
    expect(mail.endsWith(HANDOFF_CLOSE)).toBe(true);
    expect(HANDOFF_CLOSE).toContain("Do not rewrite or resend the draft");
  });

  test("a marker after a blank line or stray spaces still marks a hand-off, in the bubble and the boundary alike", () => {
    const body = `\n  ${switchMarker("abc1")}  \nThis stage continues on Anthropic · claude-fable-5-1.\n\n---\n\nHere is the conversation so far`;
    expect(handoffMarkerOf(body)).toBe("abc1");
    expect(withoutSwitchMarker({ id: "h", author: "me", body, at })).toBe(HANDOFF_BUBBLE_TEXT);
    expect(handoffMarkerOf("Make it blue")).toBeNull();
    expect(withoutSwitchMarker({ id: "s", author: "agent", body, at })).toBe(body);
  });
});

// A person's mail carrying the recap line is folded even when its marker line
// did not survive the mail store (#332 follow-up to #327).
describe("isHandoffBody", () => {
  test("recognises the recap line without a marker, and ordinary mail as not a hand-off", () => {
    const body = `Some leading line

Here is the conversation so far, so you can pick it up without restarting it:

Person: hi`;
    expect(withoutSwitchMarker({ id: "h", author: "me", body, at })).toBe(HANDOFF_BUBBLE_TEXT);
    expect(withoutSwitchMarker({ id: "p", author: "me", body: "Please resend the plan.", at })).toBe("Please resend the plan.");
  });
});
