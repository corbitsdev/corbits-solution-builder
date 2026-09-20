import { describe, expect, test } from "bun:test";
import type { WorkflowRunEvent } from "@intx/hub-client";
import { foldProjectWorkflow, newestIterationHasHoldOutput } from "./project-workflow.ts";

// Fixtures modeled on the deployed proof's own recorded wire shape
// (scripts/project-workflow-proof-deployed.ts's `finalStateFrom`/
// `applyStepOutputFrom`): a `StepCompleted` event whose `body.output.ref` is
// an `inline:<json>` string. Real deployed-proof runs exercise this exact
// decode path end to end; these fixtures isolate the fold.
function inline(value: unknown): { ref: string } {
  return { ref: `inline:${JSON.stringify(value)}` };
}

function stepCompleted(stepId: string, output: unknown): WorkflowRunEvent {
  return { seq: 0, type: "StepCompleted", body: { stepId, output: inline(output) } };
}

const OWNER = "owner-principal";

describe("foldProjectWorkflow", () => {
  test("no events yet: an empty, not-done view with nothing allowed but opening a review", () => {
    const view = foldProjectWorkflow([], {});
    expect(view.done).toBe(false);
    expect(view.openReview).toBeNull();
    expect(view.lastRefusal).toBeNull();
    expect(view.allowed).toEqual({ openReview: true, approve: false, sendBack: true, approveReason: "no_open_review" });
  });

  test("reads the newest iteration's apply output when the run has not converged", () => {
    const openReview = {
      projectId: "p1",
      stage: 1,
      done: false,
      reviews: { 1: { reviewId: "stage-1-review-1", artifactId: "p1-stage-1-artifact", version: 1, sha256: "sha-1", status: "open" } },
      decisions: [{ decisionId: "d1", kind: "open_review", stage: 1, accepted: true, principalId: OWNER, at: "t1" }],
      authorizedPrincipals: { 1: [OWNER] },
      stageOrder: [1, 2],
      reviewCounts: { 1: 1 },
    };
    const iterationEventsByRunId = {
      "run1__rework__1": [stepCompleted("apply", openReview)],
    };
    const view = foldProjectWorkflow([], iterationEventsByRunId);
    expect(view.stage).toBe(1);
    expect(view.openReview).toMatchObject({ reviewId: "stage-1-review-1", status: "open" });
    expect(view.allowed).toEqual({ openReview: true, approve: true, sendBack: true, approveReason: null });
  });

  test("picks the numerically newest iteration, not the lexicographically last one", () => {
    const stageAt = (stage: number, done: boolean) => ({
      projectId: "p1",
      stage,
      done,
      reviews: {},
      decisions: [],
      authorizedPrincipals: {},
      stageOrder: [1, 2],
      reviewCounts: {},
    });
    const iterationEventsByRunId = {
      "run1__rework__2": [stepCompleted("apply", stageAt(1, false))],
      "run1__rework__10": [stepCompleted("apply", stageAt(2, false))],
      "run1__rework__9": [stepCompleted("apply", stageAt(1, false))],
    };
    const view = foldProjectWorkflow([], iterationEventsByRunId);
    expect(view.stage).toBe(2);
  });

  test("a refused decision surfaces as lastRefusal without blocking further allowed actions", () => {
    const state = {
      projectId: "p1",
      stage: 2,
      done: false,
      reviews: { 2: { reviewId: "stage-2-review-1", artifactId: "p1-stage-2-artifact", version: 1, sha256: "sha-2", status: "open" } },
      decisions: [
        { decisionId: "d1", kind: "open_review", stage: 2, accepted: true, principalId: OWNER, at: "t1" },
        { decisionId: "d2", kind: "approve", stage: 2, accepted: false, reason: "hash_mismatch", principalId: OWNER, at: "t2" },
      ],
      authorizedPrincipals: { 2: [OWNER] },
      stageOrder: [1, 2],
      reviewCounts: { 2: 1 },
    };
    const view = foldProjectWorkflow([], { "run1__rework__1": [stepCompleted("apply", state)] });
    expect(view.lastRefusal).toMatchObject({ decisionId: "d2", accepted: false, reason: "hash_mismatch" });
    expect(view.allowed.approve).toBe(true);
  });

  test("reads the newest iteration's hold output when no decision has landed there yet", () => {
    const held = {
      projectId: "p1",
      stage: 1,
      done: false,
      reviews: {},
      decisions: [],
      authorizedPrincipals: { 1: [OWNER] },
      stageOrder: [1, 2],
      reviewCounts: {},
    };
    const view = foldProjectWorkflow([], { "run1__rework__3": [stepCompleted("hold", held)] });
    expect(view.stage).toBe(1);
    expect(view.allowed.openReview).toBe(true);
  });

  test("falls back to the previous iteration's apply output when the newest has neither apply nor hold yet", () => {
    const previousApplied = {
      projectId: "p1",
      stage: 2,
      done: false,
      reviews: {},
      decisions: [],
      authorizedPrincipals: { 2: [OWNER] },
      stageOrder: [1, 2],
      reviewCounts: {},
    };
    const iterationEventsByRunId = {
      "run1__rework__1": [stepCompleted("apply", previousApplied)],
      "run1__rework__2": [],
    };
    const view = foldProjectWorkflow([], iterationEventsByRunId);
    expect(view.stage).toBe(2);
  });

  test("newestIterationHasHoldOutput reports whether the newest iteration's hold step has committed", () => {
    expect(newestIterationHasHoldOutput(undefined)).toBe(false);
    expect(newestIterationHasHoldOutput([])).toBe(false);
    expect(newestIterationHasHoldOutput([stepCompleted("hold", { projectId: "p1" })])).toBe(true);
  });

  test("once the loop has converged, reads the top-level run's own final state and disallows further decisions", () => {
    const finalState = {
      projectId: "p1",
      stage: 2,
      done: true,
      reviews: { 2: { reviewId: "stage-2-review-1", artifactId: "p1-stage-2-artifact", version: 1, sha256: "sha-2", status: "approved" } },
      decisions: [{ decisionId: "d1", kind: "approve", stage: 2, accepted: true, principalId: OWNER, at: "t1" }],
      authorizedPrincipals: { 1: [OWNER], 2: [OWNER] },
      stageOrder: [1, 2],
      reviewCounts: { 2: 1 },
    };
    const topEvents: WorkflowRunEvent[] = [stepCompleted("rework", { outcome: "converged", iterations: 5, final: { apply: finalState } })];
    const view = foldProjectWorkflow(topEvents, { "run1__rework__5": [stepCompleted("apply", { ...finalState, done: false })] });
    expect(view.done).toBe(true);
    expect(view.stage).toBe(2);
    expect(view.allowed).toEqual({ openReview: false, approve: false, sendBack: false, approveReason: "already_done" });
  });
});
