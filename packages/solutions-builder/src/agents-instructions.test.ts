import { describe, expect, test } from "bun:test";
import { acceptanceRange, agentsInstructions } from "./agents-instructions.ts";

const PRD = "## Functional requirements\n\n- FR-1: It works.\n\n## Acceptance criteria\n\n- AC-1: a\n- AC-2: b\n- AC-3: c\n";

describe("acceptanceRange", () => {
  test("a run of ids reads as a range; a broken run is listed; none is null", () => {
    expect(acceptanceRange(PRD)).toBe("AC-1 through AC-3");
    expect(acceptanceRange("## Acceptance criteria\n\n- AC-2: b\n- AC-5: e\n")).toBe("AC-2, AC-5");
    expect(acceptanceRange("## Acceptance criteria\n\n- AC-7: only\n")).toBe("AC-7");
    expect(acceptanceRange("## Functional requirements\n\n- FR-1: x\n")).toBeNull();
  });
});

describe("agentsInstructions", () => {
  test("names the package's own files in precedence order and the PRD's criteria", () => {
    const text = agentsInstructions({ requirements: "06-product-requirements.md", design: "04-design.html", mockups: "mockups/", plan: "06-build-plan.md" }, PRD);
    expect(text).toContain("Build the application defined by 06-product-requirements.md.");
    expect(text).toContain("1. 06-product-requirements.md");
    expect(text).toContain("2. 04-design.html and mockups/");
    expect(text).toContain("3. 06-build-plan.md");
    expect(text).toContain("It MUST NOT override the PRD.");
    expect(text).toContain("Record unresolved product decisions in QUESTIONS.md");
    expect(text).toContain("Implementation is complete only when AC-1 through AC-3 pass.");
  });

  test("says what is missing rather than naming a file that is not there", () => {
    const text = agentsInstructions({ requirements: "product-requirements.md", design: null, mockups: null, plan: null }, "## Acceptance criteria\n");
    expect(text).toContain("2. (no design document in this package)");
    expect(text).toContain("3. (no build plan in this package)");
    expect(text).toContain("every acceptance criterion in the PRD passes.");
  });
});
