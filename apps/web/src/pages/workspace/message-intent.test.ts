import { describe, expect, test } from "bun:test";
import { askKind, requirementsRequest, routedLine } from "./message-intent.ts";

describe("requirementsRequest", () => {
  test("a request to change the requirements document is the author's", () => {
    expect(requirementsRequest("Please rewrite the PRD")).toBe(true);
    expect(requirementsRequest("Revise the requirements document using the Application review")).toBe(true);
    expect(requirementsRequest("fix FR-9 in the product requirements")).toBe(true);
  });

  test("asks about the requirements that are the architect's own stay with the architect", () => {
    expect(requirementsRequest("Plan against the PRD as approved and carry the feedback as risks")).toBe(false);
    expect(requirementsRequest("Cite the requirements by id in every task")).toBe(false);
    expect(requirementsRequest("Make the Gantt wider")).toBe(false);
    expect(requirementsRequest("What does FR-9 mean in the PRD?")).toBe(false);
  });

  test("the routed line says where the message went", () => {
    expect(routedLine()).toContain("requirements author");
  });
});

describe("askKind", () => {
  test("a question, a change to an existing draft, and a first draft read differently", () => {
    expect(askKind("Why is the Gantt read-only?", true)).toBe("question");
    expect(askKind("can you show the cost split", true)).toBe("question");
    expect(askKind("Revise the plan: drop Syncfusion", true)).toBe("redraft");
    expect(askKind("Here is the brief.", false)).toBe("draft");
    expect(askKind(null, true)).toBe("redraft");
    expect(askKind(null, false)).toBe("draft");
  });
});
