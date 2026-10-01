import { describe, expect, test } from "bun:test";
import { extractRequirementItems, renderRequirementsBlock, mintRequirementEntries, requirementsDiffer } from "./requirements.ts";

const DOC = `## Purpose

Some purpose text.

## Functional requirements

1. FR-1: The system does a thing.
2. The system does another thing.

## Non-functional requirements

- NFR-1: It is fast.

## Interface requirements

- The person sees a button.

## Acceptance criteria

1. AC-1: Clicking the button does the thing.

## Assumptions

Not a requirement section.
`;

describe("extractRequirementItems", () => {
  test("pulls items per section, keeping the id the author wrote and leaving an unnumbered item bare (#347)", () => {
    const items = extractRequirementItems(DOC);
    expect(items).toEqual([
      { kind: "FR", text: "The system does a thing.", id: "FR-1" },
      { kind: "FR", text: "The system does another thing." },
      { kind: "NFR", text: "It is fast.", id: "NFR-1" },
      { kind: "IR", text: "The person sees a button." },
      { kind: "AC", text: "Clicking the button does the thing.", id: "AC-1" },
    ]);
  });

  test("an item written as a paragraph under its own bold id is an item too", () => {
    const doc = "## Functional requirements\n**FR-1.** The system shall detect balls. (From stage 1.)\n\n**FR-2.** The system shall confirm pots.\n\n## Acceptance criteria\nAC-1: A pot updates the score.\n";
    expect(extractRequirementItems(doc)).toEqual([
      { kind: "FR", text: "The system shall detect balls. (From stage 1.)", id: "FR-1" },
      { kind: "FR", text: "The system shall confirm pots.", id: "FR-2" },
      { kind: "AC", text: "A pot updates the score.", id: "AC-1" },
    ]);
  });

  test("an item as a table row keyed by its id is an item too", () => {
    const doc = "## Functional requirements\n\n| ID | Requirement |\n|---|---|\n| FR-1 | The CLI shall elicit a policy. |\n| FR-2 | The policy shall have stable ids. |\n\n## Acceptance criteria\n\n| ID | Check |\n|---|---|\n| AC-1 | A lint reports every clause. |\n";
    expect(extractRequirementItems(doc)).toEqual([
      { kind: "FR", text: "The CLI shall elicit a policy.", id: "FR-1" },
      { kind: "FR", text: "The policy shall have stable ids.", id: "FR-2" },
      { kind: "AC", text: "A lint reports every clause.", id: "AC-1" },
    ]);
  });

  test("sections outside the four requirement headings are ignored", () => {
    const items = extractRequirementItems("## Assumptions\n\n- Not a requirement.\n");
    expect(items).toEqual([]);
  });
});

describe("renderRequirementsBlock", () => {
  test("renders the minted ids as a block", () => {
    const block = renderRequirementsBlock([
      { id: "FR-1", kind: "FR", text: "The system does a thing." },
      { id: "AC-1", kind: "AC", text: "Clicking the button does the thing." },
    ]);
    expect(block).toBe(
      ["## Requirements (authoritative ids)", "", "- FR-1: The system does a thing.", "- AC-1: Clicking the button does the thing."].join("\n"),
    );
  });

  test("says nothing is minted yet when empty", () => {
    expect(renderRequirementsBlock([])).toContain("None minted yet");
  });
});

// #347: ids are identifiers. A document that keeps FR-9 means the same
// FR-9 after a revision; only what is unnumbered is minted, after the highest.
describe("mintRequirementEntries", () => {
  test("keeps the document's own ids, numbers the rest after the highest in use, and renumbers an id of the wrong kind", () => {
    const entries = mintRequirementEntries([
      { kind: "FR", text: "a", id: "FR-3" },
      { kind: "FR", text: "b" },
      { kind: "FR", text: "c", id: "FR-9" },
      { kind: "FR", text: "d", id: "AC-2" },
      { kind: "AC", text: "e", id: "AC-2" },
      { kind: "AC", text: "f", id: "AC-2" },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["FR-3", "FR-10", "FR-9", "FR-11", "AC-2", "AC-3"]);
  });

  test("an unnumbered document mints as before, per kind in order", () => {
    expect(mintRequirementEntries([{ kind: "FR", text: "a" }, { kind: "AC", text: "b" }, { kind: "FR", text: "c" }]).map((e) => e.id)).toEqual(["FR-1", "AC-1", "FR-2"]);
  });

  test("requirementsDiffer tells a changed document from the same one", () => {
    const minted = mintRequirementEntries([{ kind: "FR", text: "a", id: "FR-1" }, { kind: "FR", text: "b", id: "FR-2" }]);
    expect(requirementsDiffer([{ kind: "FR", text: "a", id: "FR-1" }, { kind: "FR", text: "b", id: "FR-2" }], minted)).toBe(false);
    expect(requirementsDiffer([{ kind: "FR", text: "b", id: "FR-1" }, { kind: "FR", text: "a", id: "FR-2" }], minted)).toBe(true);
    expect(requirementsDiffer([{ kind: "FR", text: "a", id: "FR-1" }], minted)).toBe(true);
  });
});
