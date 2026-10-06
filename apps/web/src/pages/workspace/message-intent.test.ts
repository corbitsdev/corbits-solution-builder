import { describe, expect, test } from "bun:test";
import { askKind, delegationTarget, requirementsRequest, routedLine } from "./message-intent.ts";

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

// #688: "have the GUI builder…" at another stage reaches that specialist.
describe("delegationTarget", () => {
  test("a delegation verb and a specialist's name name the stage; the current stage's own specialist is not a delegation", () => {
    expect(delegationTarget("have the GUI builder add the SMTP and search account sections mentioned in the build plan", 7)).toEqual({ stage: 4 });
    expect(delegationTarget("Ask the architect to split task 11", 7)).toEqual({ stage: 6 });
    expect(delegationTarget("tell the estimator the roster is 40 people", 8)).toEqual({ stage: 7 });
    expect(delegationTarget("have the designer darken the header", 4)).toBeNull();
    expect(delegationTarget("the designer made a good choice here", 7)).toBeNull();
    expect(delegationTarget("make the Gantt wider", 6)).toBeNull();
  });
});

// #768: the app's briefs to the Build supervisor are their own kind of ask.
describe("askKind for supervisor briefs", () => {
  test("a progress brief and a record brief are status asks, whatever draft exists", () => {
    expect(askKind("Build attempt 1 is still running; write an interim build status from this record, as of turn 185 at 1:34 AM.", true)).toBe("status");
    expect(askKind("Build attempt 2 has ended and its work is recorded. Write the build status from this record.", false)).toBe("status");
    expect(askKind("Build attempt notes from the person", true)).toBe("redraft");
  });
});
