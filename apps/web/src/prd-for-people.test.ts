import { describe, expect, test } from "bun:test";
import { cleanPeopleDocument, composePeopleBrief, mockupKey, mockupReference, resolveMockupReferences } from "./prd-for-people.ts";

describe("mockup references", () => {
  test("a screen's reference is its slug under mockups/, and the key matches it", () => {
    expect(mockupReference("phone home")).toBe("mockups/phone-home.png");
    expect(mockupReference("Find buyers")).toBe("mockups/find-buyers.png");
    expect(mockupKey("Find buyers")).toBe("find-buyers");
  });

  test("resolves the references it has pictures for and leaves the rest as written", () => {
    const text = "![Home](mockups/phone-home.png)\n\n![Buyers](mockups/find-buyers.png)";
    const resolved = resolveMockupReferences(text, new Map([["phone-home", "mockups/01-phone-home.png"]]));
    expect(resolved).toBe("![Home](mockups/01-phone-home.png)\n\n![Buyers](mockups/find-buyers.png)");
    expect(resolveMockupReferences(text, new Map([["find-buyers", "data:image/png;base64,AAAA"]]))).toContain("![Buyers](data:image/png;base64,AAAA)");
  });
});

describe("composePeopleBrief", () => {
  test("names each screen with its exact path, attaches the PRD, and says when it is a revision", () => {
    const brief = composePeopleBrief({ requirements: "# PRD\n\nFR-1 it works.", screens: ["phone home", "Find buyers"], approvedInputs: "the brief" });
    expect(brief.startsWith("Write the PRD for people from the product requirements below.")).toBe(true);
    expect(brief).toContain("- phone home: `mockups/phone-home.png`");
    expect(brief).toContain("- Find buyers: `mockups/find-buyers.png`");
    expect(brief).toContain("## Attached: Product requirements");
    expect(brief).toContain("FR-1 it works.");
    expect(brief).toContain("## Attached: Approved inputs");
    const revision = composePeopleBrief({ requirements: "# PRD", screens: [], prior: "# Old" });
    expect(revision.startsWith("Revise the PRD for people")).toBe(true);
    expect(revision).toContain("names no screens");
    expect(revision).toContain("## Attached: PRD for people (prior revision)");
  });
});

// #742: the document never speaks of itself.
describe("cleanPeopleDocument", () => {
  test("drops the lead line before the title, a paragraph naming the file, and the closing source section", () => {
    const written = [
      "PRD-for-PEOPLE.md is ready: a plain-language reading of the Build plan requirements, one section per screen in the order you meet them, with every statement tied to the requirement it comes from.",
      "",
      "# Agentic Agency",
      "",
      "## In short",
      "",
      "- **Finds and describes people** a talent agency works with.",
      "",
      "## What this application does",
      "",
      "It gathers public pages about a person and writes a dossier (FR-1).",
      "",
      "This document explains the requirements for people.",
      "",
      "## A tour of the application",
      "",
      "### People",
      "",
      "![The People screen](mockups/people.png)",
      "",
      "The list is ready when the collection finishes (FR-20).",
      "",
      "## Where this comes from",
      "",
      "Drawn from Product requirements version 3; this document adds nothing to it.",
      "",
    ].join("\n");
    const cleaned = cleanPeopleDocument(written);
    expect(cleaned.startsWith("# Agentic Agency")).toBe(true);
    expect(cleaned).not.toContain("PRD-for-PEOPLE");
    expect(cleaned).not.toContain("This document explains");
    expect(cleaned).not.toContain("Where this comes from");
    expect(cleaned).not.toContain("adds nothing");
    expect(cleaned).toContain("- **Finds and describes people**");
    expect(cleaned).toContain("It gathers public pages about a person and writes a dossier (FR-1).");
    expect(cleaned).toContain("![The People screen](mockups/people.png)");
    expect(cleaned).toContain("The list is ready when the collection finishes (FR-20).");
  });

  test("leaves a clean document as it is", () => {
    const clean = "# Title\n\n## In short\n\n- **One.**\n\n## What this application does\n\nIt does one thing (FR-1).";
    expect(cleanPeopleDocument(clean)).toBe(clean);
  });
});
