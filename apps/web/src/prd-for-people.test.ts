import { describe, expect, test } from "bun:test";
import { composePeopleBrief, mockupKey, mockupReference, resolveMockupReferences } from "./prd-for-people.ts";

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
