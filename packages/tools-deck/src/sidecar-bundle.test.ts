import { describe, expect, test } from "bun:test";
import { deck, TOOL_NAME } from "./sidecar-bundle.js";

const controller = new AbortController();
const bundle = deck({} as never);

/** The tool's reply as text: it always answers with a JSON string or an error message. */
async function call(id: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  const result = await bundle.run({ id, name: TOOL_NAME, arguments: args }, controller.signal);
  return { content: typeof result.content === "string" ? result.content : JSON.stringify(result.content), ...(result.isError !== undefined ? { isError: result.isError } : {}) };
}

const PACKAGE = `## Audience: Finance

### Deck outline

1. **The problem** — Costs are rising faster than revenue.
2. **What it looks like**
3. **The plan** — Ship the pilot in Q1.

### Decision request

- Approve the pilot budget.
`;

// #285: the tool reports the deck it rendered; it never hands the file back
// into the specialist's context.
describe("render_deck", () => {
  test("reports the rendered deck's shape and digest, not its bytes", async () => {
    const result = await call("c1", { projectTitle: "Acme", audience: "Finance", role: "budget approver", markdown: PACKAGE });
    expect(result.isError).toBeUndefined();
    const report = JSON.parse(result.content) as Record<string, unknown>;
    expect(report.fileName).toBe("acme-finance-slides.pptx");
    expect(report.mediaType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(report.slides).toBe(5);
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.sizeBytes as number).toBeGreaterThan(1000);
    expect(report.look).toEqual({ theme: "ember", typeface: "Calibri", density: "standard", notes: true });
    expect(result.content).not.toContain("data:");
    expect(result.content.length).toBeLessThan(600);
  });

  test("the design and theme are honoured in the report's look", async () => {
    const result = await call("c2", {
      projectTitle: "Acme",
      audience: "Finance",
      role: "budget approver",
      markdown: PACKAGE,
      design: { theme: "navy", typeface: "Georgia", notes: false },
      theme: { accent: "1E3A8A", ratio: 1.33 },
    });
    const report = JSON.parse(result.content) as { look: Record<string, unknown> };
    expect(report.look).toEqual({ theme: "navy", typeface: "Georgia", density: "standard", notes: false });
  });

  test("a package with no deck outline is refused with the reason", async () => {
    const result = await call("c3", { projectTitle: "Acme", audience: "Finance", role: "budget approver", markdown: "## Audience: Finance\n\n### One-pager\nWorth it." });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no "### Deck outline" section');
  });
});
