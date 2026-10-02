import { describe, expect, test } from "bun:test";
import { ensureChoiceSection, personAsk, revisionMail, revisionRequest, splitRevision, standingDirections, withChoiceReminder } from "./stage-prompt.js";

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

describe("revisionRequest carries the current version, as alpha main's round did", () => {
  test("the document, the revise instruction and the ask, in that order, and the split finds them again", () => {
    const out = revisionRequest({ stage: 2, userInput: "Drop the mobile form.", currentDocument: "## In short\n- fine\n" });
    expect(out.indexOf("## In short")).toBeLessThan(out.indexOf("Revise the current version above"));
    expect(out.indexOf("Revise the current version above")).toBeLessThan(out.indexOf("Drop the mobile form."));
    expect(splitRevision(out)).toEqual({ document: "## In short\n- fine", ask: "Drop the mobile form." });
    expect(splitRevision("Drop the mobile form.")).toBeNull();
  });
});

describe("revisionMail names an artifact instead of pasting it", () => {
  const document = "## In short\n- The brief stays.\n\n## Problem statement\nA long document that must not ride in the mail.";

  test("a warm turn is the id, the version, and the sentence", () => {
    const out = revisionMail({
      artifactId: "art_123",
      version: 6,
      userInput: "Keep reviews human.",
      cold: false,
      directions: ["100% agent driven."],
      interviewing: false,
    });
    expect(out).toContain("Current version: art_123 v6.");
    expect(out).toContain("Do not call artifact_read.");
    expect(out).toContain("Keep reviews human.");
    expect(out).not.toContain("100% agent driven.");
    expect(out).not.toContain(document);
    expect(out).not.toContain("STANDING DIRECTIONS");
  });

  test("a cold turn reads once and states the earlier sentences once", () => {
    const out = revisionMail({
      artifactId: "art_123",
      version: 6,
      userInput: "Keep reviews human.",
      cold: true,
      directions: ["100% agent driven.", "No auto-merge."],
      interviewing: true,
    });
    expect(out).toContain("Call artifact_read on it once");
    expect(out).toContain("- 100% agent driven.");
    expect(out).toContain("- No auto-merge.");
    expect(out).toContain("Fold this answer into the document.");
    expect(out).not.toContain(document);
  });

  test("personAsk keeps the sentence and drops the fold line", () => {
    const mail = revisionMail({
      artifactId: "art_123",
      version: 6,
      userInput: "Keep reviews human.",
      cold: false,
      directions: [],
      interviewing: true,
    });
    expect(personAsk(mail)).toBe("Keep reviews human.");
    expect(personAsk("Drop the mobile form.")).toBe("Drop the mobile form.");
  });

  test("standing directions keep the newest asks that fit", () => {
    const out = standingDirections(["one", "x".repeat(3990), "last"]);
    expect(out).toBe(`- ${"x".repeat(3990)}\n- last`);
    expect(out).not.toContain("one");
  });
});
