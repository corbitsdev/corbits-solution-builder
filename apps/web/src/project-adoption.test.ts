import { describe, expect, test } from "bun:test";
import { adoptionPlan } from "./project-adoption.ts";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "art_1",
    kind: "problem_brief",
    variant: null,
    stage: 1,
    title: "Draft",
    version: 1,
    artifactId: "art_1",
    contentHash: "art_1@1",
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    approvedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function untouchedView(): ProjectWorkflowView {
  return {
    stage: 1,
    done: false,
    openReview: null,
    reviews: {},
    decisions: [],
    lastRefusal: null,
    allowed: { openReview: true, approve: false, sendBack: true },
    freeze: null,
  };
}

describe("adoptionPlan", () => {
  test("replays every legacy-approved stage in order", () => {
    const nodes = [
      node({ id: "a1", artifactId: "a1", stage: 1, kind: "problem_brief", version: 1 }),
      node({ id: "a2", artifactId: "a2", stage: 2, kind: "solution_constraints", version: 1 }),
    ];
    const plan = adoptionPlan(nodes, untouchedView(), [1, 2, 3]);
    expect(plan).toEqual([
      { stage: 1, artifactId: "a1", version: 1, content: "" },
      { stage: 2, artifactId: "a2", version: 1, content: "" },
    ]);
  });

  test("stops at the first stage with no approved artifact", () => {
    const nodes = [node({ id: "a1", artifactId: "a1", stage: 1, kind: "problem_brief", version: 1 })];
    const plan = adoptionPlan(nodes, untouchedView(), [1, 2, 3]);
    expect(plan.map((p) => p.stage)).toEqual([1]);
  });

  test("picks the newest version, ignores superseded and unapproved artifacts", () => {
    const nodes = [
      node({ id: "a1", artifactId: "a1", stage: 1, kind: "problem_brief", version: 1, supersededByNodeId: "a2" }),
      node({ id: "a2", artifactId: "a2", stage: 1, kind: "problem_brief", version: 2, approvedAt: null }),
      node({ id: "a3", artifactId: "a3", stage: 1, kind: "problem_brief", version: 3 }),
    ];
    const plan = adoptionPlan(nodes, untouchedView(), [1]);
    expect(plan).toEqual([{ stage: 1, artifactId: "a3", version: 3, content: "" }]);
  });

  test("does nothing once the workflow already has decisions", () => {
    const nodes = [node()];
    const decided = { ...untouchedView(), decisions: [{ decisionId: "d1", kind: "open_review", stage: 1, accepted: true, principalId: "p" }] } as ProjectWorkflowView;
    expect(adoptionPlan(nodes, decided, [1, 2])).toEqual([]);
  });

  test("does nothing once the workflow has already advanced past its first stage", () => {
    const nodes = [node()];
    expect(adoptionPlan(nodes, { ...untouchedView(), stage: 2 }, [1, 2])).toEqual([]);
  });
});
