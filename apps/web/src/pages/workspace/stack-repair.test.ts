import { describe, expect, test } from "bun:test";
import { repairedStackDraft, stackCarriedFromEarlierVersion, withStackSection } from "./stack-repair.ts";
import type { ChatMessage } from "../../stage-mail.ts";

const msg = (id: string, author: "me" | "agent", body: string): ChatMessage => ({ id, author, body, at: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z` });
const STACK = ["## Stack", "", "```json stack", JSON.stringify({ mode: "plain", runtime: { choice: "bun", reason: "r", cites: ["FR-1"] }, ui: null, storage: null, auth: null, packaging: { choice: "cli", reason: "r", cites: ["FR-1"], kind: "cli" }, packages: [], deferred: [] }), "```"].join("\n");
const headed = (middle: string) => ["Status line.", "", "## In short", "- a", "", "## Architecture", "Words.", "", middle, "## Components and interfaces", "Parts.", "", "## Tasks in order", "1. one", ""].join("\n");
const v1 = headed(`${STACK}\n\n`);
const v2NoStack = headed("");
const v2Unchanged = headed("## Stack\n\nThe stack is unchanged from v1.\n\n");

describe("stackCarriedFromEarlierVersion", () => {
  const versions: Record<number, string> = { 1: v1, 2: v2NoStack };
  const read = async (version: number) => versions[version]!;

  test("a version that dropped the block gets the newest earlier version's block; one that has it needs nothing", async () => {
    expect(await stackCarriedFromEarlierVersion(v2NoStack, 3, read)).toContain("```json stack");
    expect(await stackCarriedFromEarlierVersion(v1, 3, read)).toBeNull();
    expect(await stackCarriedFromEarlierVersion(v2NoStack, 2, async () => v2NoStack)).toBeNull();
  });
});

describe("repairedStackDraft", () => {
  test("a revision that dropped the block gets the earlier version's block before Components", () => {
    const messages = [msg("1", "agent", v1), msg("2", "me", "narrow it"), msg("3", "agent", v2NoStack)];
    const out = repairedStackDraft(6, messages, messages[2]!);
    expect(out?.body).toContain("```json stack");
    expect(out!.body.indexOf("## Stack")).toBeLessThan(out!.body.indexOf("## Components and interfaces"));
  });

  test("a revision that says the stack is unchanged has that section replaced by the real block", () => {
    const messages = [msg("1", "agent", v1), msg("2", "me", "narrow it"), msg("3", "agent", v2Unchanged)];
    const out = repairedStackDraft(6, messages, messages[2]!);
    expect(out?.body).toContain("```json stack");
    expect(out?.body).not.toContain("The stack is unchanged");
  });

  test("a draft with its own valid block, another stage, or no earlier block passes through as the same object", () => {
    const own = [msg("1", "agent", v1)];
    expect(repairedStackDraft(6, own, own[0]!)).toBe(own[0]!);
    const none = [msg("1", "agent", v2NoStack)];
    expect(repairedStackDraft(6, none, none[0]!)).toBe(none[0]!);
    expect(repairedStackDraft(3, [msg("1", "agent", v1), msg("2", "agent", v2NoStack)], msg("2", "agent", v2NoStack))).toEqual(msg("2", "agent", v2NoStack));
  });

  test("a dollar sign in the block's text is written in verbatim, and a later fence is left alone", () => {
    const dollar = STACK.replace('"reason":"r"', () => '"reason":"costs $$ and $& more"');
    const out = withStackSection(v2Unchanged, dollar);
    expect(out).toContain('"reason":"costs $$ and $& more"');
    const later = headed("## Stack\n\nunchanged\n\n") + "```json\n{}\n```\n";
    const repaired = withStackSection(later, STACK);
    expect(repaired).toContain("## Components and interfaces");
    expect(repaired.split("```json").length).toBe(3);
  });

  test("withStackSection appends when no later heading exists", () => {
    expect(withStackSection("## In short\n- a\n", STACK).trimEnd().endsWith("```")).toBe(true);
  });
});
