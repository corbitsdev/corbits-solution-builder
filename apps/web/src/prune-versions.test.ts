import { describe, expect, test } from "bun:test";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import { prunePlan, prunePlanSummary, type PruneNode } from "./prune-versions.ts";

const node = (id: string, kind: string, stage: number, version: number, supersededBy: string | null, variant: string | null = null): PruneNode => ({
  id,
  kind,
  variant,
  stage,
  supersededByNodeId: supersededBy,
  createdAt: `2026-01-0${String(version)}T00:00:00.000Z`,
});

const review = (artifactId: string, status: "open" | "approved" | "stale" = "approved") => ({ reviewId: `r-${artifactId}`, artifactId, version: 1, sha256: "", status });

function view(partial: Partial<ProjectWorkflowView>): ProjectWorkflowView {
  return {
    stage: 5,
    done: false,
    openReview: null,
    reviews: {},
    decisions: [],
    lastRefusal: null,
    allowed: { openReview: false, approve: false, sendBack: false, approveReason: null },
    freeze: null,
    requirements: [],
    audiencePolicy: null,
    audienceDecisions: {},
    audiencePackages: {},
    stage5Quorum: null,
    ...partial,
  } as ProjectWorkflowView;
}

describe("prunePlan", () => {
  test("keeps the newest of each lineage and archives the superseded drafts", () => {
    const nodes = [node("b1", "problem_brief", 1, 1, "b2"), node("b2", "problem_brief", 1, 2, "b3"), node("b3", "problem_brief", 1, 3, null)];
    const plan = prunePlan(nodes, null);
    expect(plan.keep.map((n) => n.id)).toEqual(["b3"]);
    expect(plan.archive.map((n) => n.id)).toEqual(["b1", "b2"]);
    expect(plan.lineages).toBe(1);
  });

  test("keeps an older version a review or decision names, even when newer drafts exist", () => {
    const nodes = [node("d1", "design_artifact", 4, 1, "d2"), node("d2", "design_artifact", 4, 2, "d3"), node("d3", "design_artifact", 4, 3, null)];
    const approvedOld = prunePlan(nodes, view({ reviews: { 4: review("d1") } as ProjectWorkflowView["reviews"] }));
    expect(approvedOld.keep.map((n) => n.id)).toEqual(["d1", "d3"]);
    expect(approvedOld.archive.map((n) => n.id)).toEqual(["d2"]);
    const decided = prunePlan(nodes, view({ decisions: [{ decisionId: "x", kind: "approve", stage: 4, accepted: true, principalId: "p", artifactId: "d2" }] as ProjectWorkflowView["decisions"] }));
    expect(decided.archive.map((n) => n.id)).toEqual(["d1"]);
  });

  test("a stakeholder package a vote points at is kept; variants are separate lineages", () => {
    const nodes = [
      node("p1", "audience_package", 5, 1, "p2", "Mr Finance"),
      node("p2", "audience_package", 5, 2, null, "Mr Finance"),
      node("q1", "audience_package", 5, 1, null, "Mr Tech"),
    ];
    const plan = prunePlan(nodes, view({ audiencePackages: { "Mr Finance": { artifactId: "p1", version: 1, sha256: "" } } as ProjectWorkflowView["audiencePackages"] }));
    expect(plan.keep.map((n) => n.id).sort()).toEqual(["p1", "p2", "q1"]);
    expect(plan.archive).toEqual([]);
    expect(plan.lineages).toBe(2);
  });

  test("the opening statement and delivery records are never pruned", () => {
    const nodes = [node("s1", "source_material", 1, 1, "s2"), node("s2", "source_material", 1, 2, null), node("m1", "delivery_manifest", 9, 1, "m2"), node("m2", "delivery_manifest", 9, 2, null)];
    expect(prunePlan(nodes, null).archive).toEqual([]);
  });

  test("the summary says what goes and what stays, or that nothing does", () => {
    const nodes = [node("b1", "problem_brief", 1, 1, "b2"), node("b2", "problem_brief", 1, 2, null), node("c1", "solution_constraints", 2, 1, null)];
    expect(prunePlanSummary(prunePlan(nodes, null))).toBe("Archive 1 older version across 2 documents, keeping 2: the newest of each document and every version a decision names.");
    expect(prunePlanSummary(prunePlan([node("c1", "solution_constraints", 2, 1, null)], null))).toBe("Nothing to prune: every version across 1 document is current or named by a decision.");
  });
});
