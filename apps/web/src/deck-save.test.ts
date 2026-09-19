import { describe, expect, test } from "bun:test";
import { buildPackageDeck } from "./deck-save.ts";

const OUTLINE = `# Audience package

### Deck outline

1. **The problem** — Costs are rising faster than revenue.
2. **The plan** — Ship the pilot in Q1.

### Decision request

- Approve the pilot budget.
`;

describe("buildPackageDeck", () => {
  test("builds a non-empty pptx from a fixture outline", async () => {
    const result = await buildPackageDeck({
      projectTitle: "Acme Rebuild",
      audience: "Finance",
      role: "Approver",
      markdown: OUTLINE,
    });
    expect(result.filename).toBe("acme-rebuild-finance-slides.pptx");
    expect(result.dataUrl.startsWith("data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,")).toBe(true);
    const base64 = result.dataUrl.split(",")[1]!;
    expect(base64.length).toBeGreaterThan(100);
  });

  test("throws a clear error when the outline is missing", async () => {
    await expect(
      buildPackageDeck({
        projectTitle: "Acme Rebuild",
        audience: "Finance",
        role: "Approver",
        markdown: "# Audience package\n\nNo outline here.\n",
      }),
    ).rejects.toThrow(/no "### Deck outline" section/);
  });
});
