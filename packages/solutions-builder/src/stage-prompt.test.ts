import { describe, expect, test } from "bun:test";
import { artifactRevisionRequest, composedTurn, ensureChoiceSection, personWordsIn, revisionRequest, splitRevision, withChoiceReminder } from "./stage-prompt.js";

describe("withChoiceReminder records a stage-3 choice in the document", () => {
  test("a stage-3 choice names the Chosen approach section the approval gate reads", () => {
    const out = withChoiceReminder(3, "Chosen: Approach A (Extend the worker)");
    expect(out).toContain("Chosen: Approach A (Extend the worker)");
    expect(out).toContain("## Chosen approach: Extend the worker");
    expect(personWordsIn(out)?.words).toBe("Chosen: Approach A (Extend the worker)");
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

describe("artifactRevisionRequest names the artifact instead of carrying the document", () => {
  const mail = artifactRevisionRequest({ userInput: "Chosen: Approach A (Automatic chains).", artifactId: "art_7", version: 3 });

  test("it names the id, the version and the edit to make", () => {
    expect(mail).toContain("Artifact art_7, version 3.");
    expect(mail).toContain("expectedVersion 3");
    expect(mail).toContain("artifact_write");
  });

  test("the chat and the stage 3 choice still find the person's words", () => {
    expect(splitRevision(mail)?.ask).toBe("Chosen: Approach A (Automatic chains).");
    expect(personWordsIn(mail)?.words).toBe("Chosen: Approach A (Automatic chains).");
  });

  test("a stage 3 choice with its reminder, revised by artifact, still reads as the choice", () => {
    const reminded = withChoiceReminder(3, "Chosen: Approach B (Confirmed chains)");
    const sent = artifactRevisionRequest({ userInput: reminded, artifactId: "art_7", version: 4 });
    expect(personWordsIn(sent)?.words).toBe("Chosen: Approach B (Confirmed chains)");
  });
});

describe("a composed message keeps the person's words last, after one marker", () => {
  test("the words are found through every layer the app adds", () => {
    const attached = composedTurn(["## Attached: Review\n\nFindings."], "Use the review.");
    const revised = revisionRequest({ stage: 1, userInput: attached, currentDocument: "## In short\n- x" });
    expect(personWordsIn(revised)?.words).toBe("Use the review.");
    expect(personWordsIn(revised)?.added).toContain("## Attached: Review");
  });

  test("a message with nothing added is the person's alone", () => {
    expect(composedTurn([], "Just this.")).toBe("Just this.");
    expect(personWordsIn("Just this.")).toBeNull();
  });
});
