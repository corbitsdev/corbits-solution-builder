import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import {
  openReviewFailureMessage,
  stage6RefusalMessage,
  stage6StackProblem,
  stage7StackProblem,
  stageEvidence,
  stageRefusalMessage,
  type StageEvidenceDeps, STACK_RESEND_ASK, stage6StackRemediation } from "./stage-evidence.ts";

const CHOICE = { choice: "x", reason: "because", cites: ["FR-1"] };
const STACK = {
  mode: "plain",
  runtime: CHOICE,
  ui: null,
  storage: null,
  auth: null,
  packaging: { ...CHOICE, kind: "cli" },
  packages: [],
  deferred: [],
};

function planWith(stack: unknown): string {
  return ["# Build plan", "", "## Stack", "", "```json stack", JSON.stringify(stack), "```", "", "## Tasks", "prose"].join("\n");
}

const PLAN_WITHOUT_STACK = ["# Build plan", "", "### In short", "prose", "", "### Architecture", "prose"].join("\n");

function deps(overrides: {
  planText?: string;
  planInGraph?: boolean;
  stage6Approved?: boolean;
  requirementIds?: string[];
}): StageEvidenceDeps {
  const planText = overrides.planText ?? planWith(STACK);
  const review = { status: overrides.stage6Approved === false ? "open" : "approved", artifactId: "art_plan", version: 1, sha256: "abc" };
  const workflowView = {
    reviews: { 6: review },
    requirements: (overrides.requirementIds ?? ["FR-1"]).map((id) => ({ id, kind: "FR", text: id })),
  } as unknown as ProjectWorkflowView;
  const nodes = (overrides.planInGraph === false ? [] : [{ id: "node_plan", artifactId: "art_plan", version: 1 }]) as ArtifactNode[];
  return {
    projectId: "prj",
    tenantId: "tnt",
    nodes,
    chosenTarget: "web",
    workflowView,
    artifactContent: async () => ({ content: planText }),
  };
}

describe("stage7StackProblem", () => {
  test("a plan with a valid, fully cited Stack section raises nothing", async () => {
    expect(await stage7StackProblem(deps({}))).toBeNull();
  });

  test("a plan approved without a Stack section names the build plan and stage 6, and offers the send-back to stage 6", async () => {
    const problem = await stage7StackProblem(deps({ planText: PLAN_WITHOUT_STACK }));
    expect(problem).not.toBeNull();
    expect(problem!.message).toContain("build plan");
    expect(problem!.message).toContain("Build plan");
    expect(problem!.message).not.toContain("stack decision");
    expect(problem!.remediation).toMatchObject({ kind: "send_back", targetStage: 6 });
    expect(problem!.remediation!.reason).toContain("Stack section");
  });

  test("a Stack section citing an unknown requirement is reported with the detail and the same way out", async () => {
    const problem = await stage7StackProblem(deps({ requirementIds: ["FR-9"] }));
    expect(problem!.message).toContain("FR-1");
    expect(problem!.message).toContain("Build plan");
    expect(problem!.remediation).toMatchObject({ kind: "send_back", targetStage: 6 });
  });

  test("an approved plan the artifact graph does not hold is a read problem, with no send-back", async () => {
    const problem = await stage7StackProblem(deps({ planInGraph: false }));
    expect(problem!.message).toContain("could not be read");
    expect(problem!.remediation).toBeUndefined();
  });

  test("no approved stage 6 review is the workflow's evidence check to answer, not this one's", async () => {
    expect(await stage7StackProblem(deps({ stage6Approved: false, planText: PLAN_WITHOUT_STACK }))).toBeNull();
  });
});

describe("refusal copy", () => {
  test("a structural refusal reads as the workflow contract's own sentence, never its raw code", () => {
    expect(stageRefusalMessage("wrong_stage")).toBe("The project has moved to a different stage.");
    expect(stageRefusalMessage("stale_review")).not.toBe("stale_review");
    expect(stageRefusalMessage("something_unknown")).toBe("something_unknown");
  });
});

// #169: a review that did not open is said, with its reason.
describe("openReviewFailureMessage", () => {
  test("says nothing when the view moved on or another tab landed the same decision", () => {
    expect(openReviewFailureMessage("wrong_stage")).toBeNull();
    expect(openReviewFailureMessage("signal_id_conflict")).toBeNull();
  });

  test("names an unreadable workflow and a review accepted but never applied", () => {
    expect(openReviewFailureMessage("workflow_unavailable")).toBe("The project workflow could not be read.");
    expect(openReviewFailureMessage("timed_out")).toContain("has not shown it open");
  });

  test("reads a refused open_review in the workflow's own words", () => {
    expect(openReviewFailureMessage("evidence_missing")).toBe("The recorded decisions don't match what this approval expects.");
    expect(openReviewFailureMessage("stale_review")).toBe(stageRefusalMessage("stale_review"));
  });
});

describe("stack refusal copy", () => {
  test("names the build plan's Stack section in the person's terms, never a 'stack decision'", () => {
    for (const code of ["stack_missing", "stack_uncited", "stack_unknown_requirement"]) {
      const text = stageRefusalMessage(code);
      expect(text).toContain("build plan");
      expect(text).not.toContain("stack decision");
    }
    expect(stageRefusalMessage("stack_missing")).toContain("Build plan");
    expect(stage6StackProblem(PLAN_WITHOUT_STACK, new Set(["FR-1"]))).toContain("build plan");
    expect(stage6StackProblem(PLAN_WITHOUT_STACK, new Set(["FR-1"]))).not.toContain("stack decision");
  });
});

// #55: the reducer's stage6Rule decides; the client hands it the plan's Stack
// and reads its refusal back in the plan's terms.
describe("stage 6 evidence", () => {
  const deps = (planText: string): StageEvidenceDeps => ({
    projectId: "p",
    tenantId: "t",
    nodes: [],
    chosenTarget: null,
    workflowView: null,
    artifactContent: async () => ({ content: "" }),
    planText,
  });

  test("carries the plan's parsed Stack section", async () => {
    const evidence = (await stageEvidence(6, deps(planWith(STACK)))) as unknown as { stack: { runtime?: { cites?: string[] } } };
    expect(evidence.stack.runtime?.cites).toEqual(["FR-1"]);
  });

  test("still carries evidence when the plan has no Stack, so the workflow refuses it rather than a pre-rule approval passing", async () => {
    const evidence = (await stageEvidence(6, deps(PLAN_WITHOUT_STACK))) as unknown as { stack: unknown };
    expect(evidence).toEqual({ stack: {} });
  });

  test("a stage 6 refusal reads as a plan to correct, not a send-back", () => {
    for (const code of ["stack_missing", "stack_uncited", "stack_unknown_requirement"]) {
      const text = stage6RefusalMessage(code);
      expect(text).toContain("Ask the architect");
      expect(text).not.toContain("Send the project back");
    }
    expect(stage6RefusalMessage("wrong_stage")).toBe(stageRefusalMessage("wrong_stage"));
  });
});

// #325: a redraft that says its stack is "unchanged" under the heading has no
// stack, and the way out is one click that asks the architect for the block.
describe("stage6StackRemediation", () => {
  test("a Stack heading with prose and no fenced block is a missing stack, and the remediation sends the ask", () => {
    const plan = "## In short\n\nx\n\n## Stack\n\nThe approved mode and stack record stand exactly as written.\n\n## Architecture decision records\n";
    expect(stage6StackProblem(plan, new Set(["FR-1"]))).toContain("Stack section is missing");
    const remediation = stage6StackRemediation();
    expect(remediation).toMatchObject({ kind: "ask_specialist", label: "Ask the architect to resend it", message: STACK_RESEND_ASK });
    expect(STACK_RESEND_ASK).toContain("```json stack");
    expect(STACK_RESEND_ASK).toContain("even though nothing in it changed");
  });
});
