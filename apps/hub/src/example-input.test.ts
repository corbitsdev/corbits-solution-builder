import { describe, expect, test } from "bun:test";
import { extractExampleInput } from "./completion-judge.js";

// A real requirements document writes its example as `## Worked example` with
// `### Input` and `### Output` beneath, and fences the literal text. Both were
// enough to make the example invisible: the subheading ended the section, and
// the fence markers would have been fed to the deliverable as if a person had
// typed them. Observed on a real build whose example was present and unused.
const REAL = `## Acceptance criteria
- It works.

## Worked example
### Input
\`\`\`plaintext
Business size: medium; Industry: tech
\`\`\`

### Output
\`\`\`plaintext
Lead 1: Company A
\`\`\`

## Constraints and dependencies
- None.
`;

describe("extractExampleInput", () => {
  test("a deeper heading stays inside the example", () => {
    expect(extractExampleInput(REAL)).toContain("Business size: medium; Industry: tech");
  });

  test("fence markers are markup, not input", () => {
    expect(extractExampleInput(REAL).some((line) => line.startsWith("```"))).toBe(false);
  });

  test("a heading at the example's own level ends it", () => {
    expect(extractExampleInput(REAL)).not.toContain("None.");
  });

  test("text before the example is not collected", () => {
    expect(extractExampleInput(REAL)).not.toContain("It works.");
  });

  test("the expected output is not fed back in as input", () => {
    expect(extractExampleInput(REAL)).not.toContain("Lead 1: Company A");
  });

  test("an example with no named halves is taken whole", () => {
    const flat = "## Example\nfirst line\nsecond line\n\n## Next\n- other\n";
    expect(extractExampleInput(flat)).toEqual(["first line", "second line"]);
  });

  test("no example section yields nothing, rather than something invented", () => {
    expect(extractExampleInput("## Scope\n- A thing.\n")).toEqual([]);
  });
});
