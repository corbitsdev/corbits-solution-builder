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

// Observed on a real bench run: the requirements author wrote the halves as
// bare `Input:`/`Output:` labels instead of `### Input`/`### Output`
// subheadings, so the whole block — expected output included — was fed to
// the deliverable's stdin. Only the invocation line is real input.
const BARE_LABELS = `## Worked example
Input:
\`\`\`
agent_start.py --endpoint https://example.com/status --deadline 30000 --interval 5000
\`\`\`
Output:
- Logs in \`transcript.log\`:
\`\`\`json
{"timestamp": "2023-10-10T14:23:34.123456Z", "poll_result": {"endpoint": "https://example.com/status", "response": "in_progress", "status_code": 200}, "poll_number": 1}
\`\`\`
- Final verdict emitted to stdout:
\`\`\`plaintext
Final verdict: completed
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

  test("bare Input:/Output: labels split the halves like subheadings do", () => {
    expect(extractExampleInput(BARE_LABELS)).toEqual([
      "agent_start.py --endpoint https://example.com/status --deadline 30000 --interval 5000",
    ]);
  });

  test("a bare label with inline content contributes the content, not the label", () => {
    expect(extractExampleInput("## Example\nInput: hello\n\n## Next\n- other\n")).toEqual(["hello"]);
  });
});
