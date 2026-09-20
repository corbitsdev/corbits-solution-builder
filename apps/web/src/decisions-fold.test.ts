import { describe, expect, test } from "bun:test";
import { stageApprovalDecision } from "./decisions-fold.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";

function view(overrides: Partial<ProjectWorkflowView> = {}): ProjectWorkflowView {
  return {
    stage: 3,
    done: false,
    openReview: null,
    reviews: {},
    decisions: [],
    lastRefusal: null,
    allowed: { openReview: true, approve: false, sendBack: true },
    freeze: null,
    ...overrides,
  };
}

describe("stageApprovalDecision", () => {
  test("null once the workflow has converged, even with an open review", () => {
    const withReview = view({
      done: true,
      openReview: { reviewId: "r1", artifactId: "art_1", version: 1, sha256: "sha1", status: "open" },
    });
    expect(stageApprovalDecision("p1", "run_1", withReview, true)).toBeNull();
  });

  test("null with neither an open review nor a substantial draft", () => {
    expect(stageApprovalDecision("p1", "run_1", view(), false)).toBeNull();
  });

  test("a substantial draft alone is approvable to open, but carries no reviewRef", () => {
    const wait = stageApprovalDecision("p1", "run_1", view(), true);
    expect(wait).not.toBeNull();
    expect(wait!.reviewRef).toBeUndefined();
    expect(wait!.approvalId).toBeUndefined();
    expect(wait!.stage).toBe(3);
    expect(wait!.projectId).toBe("p1");
    expect(wait!.runId).toBe("run_1");
  });

  test("an open review carries its exact reference, so the queue may approve directly", () => {
    const withReview = view({
      openReview: { reviewId: "r1", artifactId: "art_1", version: 2, sha256: "sha2", status: "open" },
    });
    const wait = stageApprovalDecision("p1", "run_1", withReview, false);
    expect(wait?.reviewRef).toEqual({ artifactId: "art_1", version: 2, sha256: "sha2" });
  });

  test("ids are stable per project/stage, distinct from a tool-approval id", () => {
    const withReview = view({
      openReview: { reviewId: "r1", artifactId: "art_1", version: 1, sha256: "sha1", status: "open" },
    });
    const wait = stageApprovalDecision("p1", "run_1", withReview, false);
    expect(wait?.id).toBe("p1:3:stage-approval");
  });
});
