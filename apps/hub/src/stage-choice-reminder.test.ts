import { describe, expect, test } from "bun:test";
import { ensureChoiceSection, withChoiceReminder } from "@solutions-builder/app/stage-prompt";

describe("withChoiceReminder records a stage-3 choice in the document", () => {
  test("a stage-3 choice names the Chosen approach section the approval gate reads", () => {
    const out = withChoiceReminder(3, "Chosen: Approach A (Extend the worker)");
    expect(out).toContain("Chosen: Approach A (Extend the worker)");
    expect(out).toContain("## Chosen approach: Extend the worker");
  });

  test("ordinary stage-3 replies and other stages pass through untouched", () => {
    expect(withChoiceReminder(3, "Use Postgres.")).toBe("Use Postgres.");
    expect(withChoiceReminder(2, "Chosen: Approach A (Extend the worker)")).toBe("Chosen: Approach A (Extend the worker)");
  });
});

describe("ensureChoiceSection repairs a draft that ignored the reminder", () => {
  const draft = [
    "## In short",
    "",
    "Two viable approaches.",
    "",
    "## Approach A: Extend the worker",
    "",
    "How it works.",
    "",
    "## Side by side",
    "",
    "The table.",
    "",
  ].join("\n");

  test("a non-compliant draft gains the Chosen approach section after In short", () => {
    const out = ensureChoiceSection(3, "Chosen: Approach A (Extend the worker)", draft);
    expect(out).toContain("## Chosen approach: Extend the worker");
    expect(out).toContain("The person chose Approach A (Extend the worker).");
    expect(out.indexOf("## Chosen approach")).toBeGreaterThan(out.indexOf("## In short"));
    expect(out.indexOf("## Chosen approach")).toBeLessThan(out.indexOf("## Approach A"));
  });

  test("a draft that already records the choice passes through untouched", () => {
    const compliant = draft.replace("## Side by side", "## Chosen approach: Extend the worker\n\nIt won.\n\n## Side by side");
    expect(ensureChoiceSection(3, "Chosen: Approach A (Extend the worker)", compliant)).toBe(compliant);
  });

  test("ordinary replies and other stages pass through untouched", () => {
    expect(ensureChoiceSection(3, "Use Postgres.", draft)).toBe(draft);
    expect(ensureChoiceSection(2, "Chosen: Approach A (Extend the worker)", draft)).toBe(draft);
  });
});
