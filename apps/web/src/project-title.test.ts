import { describe, expect, test } from "bun:test";
import { titleFromProblem } from "./client.ts";
import { foldProjectWorkflow } from "./project-workflow.ts";

describe("titleFromProblem", () => {
  test("takes the first clause, about five words", () => {
    expect(titleFromProblem("Our invoices are reconciled by hand every month. It takes days.")).toBe("Our invoices are reconciled by");
  });

  test("skips links rather than returning one", () => {
    expect(titleFromProblem("https://github.com/acme/repo needs a release pipeline")).toBe("needs a release pipeline");
    expect(titleFromProblem("See www.example.com for the spec")).toBe("See for the spec");
  });

  test("is Untitled project when nothing but a link is left", () => {
    expect(titleFromProblem("https://github.com/acme/repo")).toBe("Untitled project");
    expect(titleFromProblem("   ")).toBe("Untitled project");
  });
});

describe("foldProjectWorkflow's generatedTitle", () => {
  const completed = (stepId: string, output: unknown) => ({
    seq: 1,
    type: "StepCompleted",
    body: { stepId, attempt: 1, output: { ref: `inline:${JSON.stringify(output)}` } },
  });

  test("is the name step's trimmed reply", () => {
    const view = foldProjectWorkflow([completed("name", { reply: "  Invoice Reconciliation  ", turn: {} })] as never, {});
    expect(view.generatedTitle).toBe("Invoice Reconciliation");
  });

  test("is null before the step completes, and for a failure sentinel", () => {
    expect(foldProjectWorkflow([], {}).generatedTitle).toBeNull();
    expect(foldProjectWorkflow([completed("nameFailed", { failed: true })] as never, {}).generatedTitle).toBeNull();
  });
});
