import { describe, expect, test } from "bun:test";
import { repairedChoiceDraft } from "./choice-repair.ts";
import { appSubject } from "./composed-mail.ts";
import type { ChatMessage } from "../../stage-mail.ts";

const msg = (id: string, author: "me" | "agent", body: string): ChatMessage => ({ id, author, body, at: `2026-01-01T00:00:0${id.length}.000Z` });
const chose = (id: string): ChatMessage => ({ ...msg(id, "me", "Chosen: Approach A (Extend)."), subject: appSubject("choice", "Extend") });
const draft = "## In short\n- two ways\n\n## Approach A: Extend\n\nHow.\n\n## Side by side\n\nTable.\n";

describe("repairedChoiceDraft", () => {
  test("a stage 3 draft after a choice gains the section the gate reads", () => {
    const messages = [msg("1", "agent", draft), chose("2"), msg("3", "agent", draft)];
    const out = repairedChoiceDraft(3, messages, messages[2]!);
    expect(out?.body).toContain("## Chosen approach: Extend");
  });

  test("a compliant draft, another stage, or no choice passes through as the same object", () => {
    const messages = [chose("1"), msg("2", "agent", draft.replace("## Side by side", "## Chosen approach: Extend\n\nWon.\n\n## Side by side"))];
    expect(repairedChoiceDraft(3, messages, messages[1]!)).toBe(messages[1]!);
    expect(repairedChoiceDraft(2, messages, messages[1]!)).toBe(messages[1]!);
    const noChoice = [msg("1", "me", "Use Postgres."), msg("2", "agent", draft)];
    expect(repairedChoiceDraft(3, noChoice, noChoice[1]!)).toBe(noChoice[1]!);
  });

  test("a choice made after the draft does not repair the draft before it", () => {
    const messages = [msg("1", "agent", draft), chose("2")];
    expect(repairedChoiceDraft(3, messages, messages[0]!)).toBe(messages[0]!);
  });
});
