import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import { stage6StackProblem, stage7StackProblem, stageRefusalMessage, type StageEvidenceDeps } from "./stage-evidence.ts";

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
    expect(problem!.message).toContain("stage 6");
    expect(problem!.message).not.toContain("stack decision");
    expect(problem!.remediation).toMatchObject({ kind: "send_back", targetStage: 6 });
    expect(problem!.remediation!.reason).toContain("Stack section");
  });

  test("a Stack section citing an unknown requirement is reported with the detail and the same way out", async () => {
    const problem = await stage7StackProblem(deps({ requirementIds: ["FR-9"] }));
    expect(problem!.message).toContain("FR-1");
    expect(problem!.message).toContain("stage 6");
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

describe("stack refusal copy", () => {
  test("names the build plan's Stack section in the person's terms, never a 'stack decision'", () => {
    for (const code of ["stack_missing", "stack_uncited", "stack_unknown_requirement"]) {
      const text = stageRefusalMessage(code);
      expect(text).toContain("build plan");
      expect(text).not.toContain("stack decision");
    }
    expect(stageRefusalMessage("stack_missing")).toContain("stage 6");
    expect(stage6StackProblem(PLAN_WITHOUT_STACK, new Set(["FR-1"]))).toContain("build plan");
    expect(stage6StackProblem(PLAN_WITHOUT_STACK, new Set(["FR-1"]))).not.toContain("stack decision");
  });
});
