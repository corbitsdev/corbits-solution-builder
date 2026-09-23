import { describe, expect, test } from "bun:test";
import { extractRequirementItems, renderRequirementsBlock } from "./requirements.js";

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
  test("pulls items per section, stripping any id the specialist wrote", () => {
    const items = extractRequirementItems(DOC);
    expect(items).toEqual([
      { kind: "FR", text: "The system does a thing." },
      { kind: "FR", text: "The system does another thing." },
      { kind: "NFR", text: "It is fast." },
      { kind: "IR", text: "The person sees a button." },
      { kind: "AC", text: "Clicking the button does the thing." },
    ]);
  });

  test("an item written as a paragraph under its own bold id is an item too", () => {
    const doc = "## Functional requirements\n**FR-1.** The system shall detect balls. (From stage 1.)\n\n**FR-2.** The system shall confirm pots.\n\n## Acceptance criteria\nAC-1: A pot updates the score.\n";
    expect(extractRequirementItems(doc)).toEqual([
      { kind: "FR", text: "The system shall detect balls. (From stage 1.)" },
      { kind: "FR", text: "The system shall confirm pots." },
      { kind: "AC", text: "A pot updates the score." },
    ]);
  });

  test("an item as a table row keyed by its id is an item too", () => {
    const doc = "## Functional requirements\n\n| ID | Requirement |\n|---|---|\n| FR-1 | The CLI shall elicit a policy. |\n| FR-2 | The policy shall have stable ids. |\n\n## Acceptance criteria\n\n| ID | Check |\n|---|---|\n| AC-1 | A lint reports every clause. |\n";
    expect(extractRequirementItems(doc)).toEqual([
      { kind: "FR", text: "The CLI shall elicit a policy." },
      { kind: "FR", text: "The policy shall have stable ids." },
      { kind: "AC", text: "A lint reports every clause." },
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
