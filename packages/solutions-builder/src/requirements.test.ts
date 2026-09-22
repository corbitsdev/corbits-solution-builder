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
