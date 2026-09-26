import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import { handoffDue } from "./use-model-handoff.ts";

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
