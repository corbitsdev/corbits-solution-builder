import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import { HANDOFF_BUBBLE_TEXT, composeModelHandoff, handoffDue, switchMarker } from "./use-model-handoff.ts";
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
