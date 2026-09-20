import { describe, expect, test } from "bun:test";
import { applyDecision, initProjectState, type ApplyDecisionInput, type ProjectState } from "./contracts.js";

const OWNER = "owner-principal";
const AT = "2026-09-19T00:00:00.000Z";
const STAGE1_SHA = "sha-stage-1-v1";

function baseState(): ProjectState {
  return initProjectState({
    projectId: "p1",
    stages: [
      { stage: 1, authorizedPrincipalIds: [OWNER] },
      { stage: 2, authorizedPrincipalIds: [OWNER] },
    ],
  });
}

function input(state: ProjectState, principalId: unknown, decision: unknown): ApplyDecisionInput {
  return { ...state, principalId, decision };
}

function openD1(): Record<string, unknown> {
  return { decisionId: "d1", kind: "open_review", projectId: "p1", stage: 1, artifactId: "p1-stage-1-artifact", version: 1, sha256: STAGE1_SHA, at: AT };
}

function approveD1(): Record<string, unknown> {
  return {
    decisionId: "d2",
    kind: "approve",
    projectId: "p1",
    stage: 1,
    reviewId: "stage-1-review-1",
    artifactId: "p1-stage-1-artifact",
    version: 1,
    sha256: STAGE1_SHA,
    at: AT,
  };
}

function withOpenReview(): ProjectState {
  return applyDecision(input(baseState(), OWNER, openD1()));
}

describe("applyDecision refusals leave state unchanged (or append one refusal)", () => {
  test("missing top-level principal", () => {
    const state = baseState();
    const next = applyDecision(input(state, undefined, approveD1()));
    expect(next).toEqual(state);
  });

  test("invalid shape", () => {
    const state = baseState();
    const next = applyDecision(input(state, OWNER, { not: "a decision" }));
    expect(next).toEqual(state);
  });

  test("unauthorized principal", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, "intruder", approveD1()));
    expect(next.stage).toBe(state.stage);
    expect(next.reviews).toEqual(state.reviews);
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "unauthorized" });
  });

  test("wrong project", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { ...approveD1(), projectId: "other" }));
    expect(next.stage).toBe(state.stage);
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "wrong_project" });
  });

  test("wrong stage", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { ...approveD1(), stage: 2 }));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "wrong_stage" });
  });

  test("stale reviewId (no open review yet)", () => {
    const state = baseState();
    const next = applyDecision(input(state, OWNER, approveD1()));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stale_review" });
  });

  test("stale reviewId (reviewId does not match the open one)", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { ...approveD1(), reviewId: "old-review" }));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stale_review" });
  });

  test("wrong artifact", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { ...approveD1(), artifactId: "other-artifact" }));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "wrong_artifact" });
  });

  test("stale version", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { ...approveD1(), version: 2 }));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stale_version" });
  });

  test("hash mismatch (payload names a hash the open review was not opened with)", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { ...approveD1(), sha256: "0".repeat(64) }));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "hash_mismatch" });
  });

  test("duplicate decisionId is refused and appends one record, leaving prior state otherwise unchanged", () => {
    const state = withOpenReview();
    const first = applyDecision(input(state, "intruder", approveD1()));
    expect(first.decisions).toHaveLength(2);
    const second = applyDecision(input(first, OWNER, { ...approveD1(), decisionId: "d2" }));
    expect(second.decisions).toHaveLength(3);
    expect(second.decisions.at(-1)).toMatchObject({ decisionId: "d2", accepted: false, reason: "duplicate" });
    expect(second.reviews).toEqual(first.reviews);
    expect(second.stage).toBe(first.stage);
  });

  test("send_back without reason is refused at shape validation", () => {
    const state = withOpenReview();
    const next = applyDecision(input(state, OWNER, { decisionId: "d3", kind: "send_back", projectId: "p1", stage: 1, targetStage: 1, at: AT }));
    expect(next).toEqual(state);
  });

  test("send_back with targetStage above current stage is refused", () => {
    const state = withOpenReview();
    const decision = { decisionId: "d3", kind: "send_back", projectId: "p1", stage: 1, targetStage: 2, reason: "not allowed", at: AT };
    const next = applyDecision(input(state, OWNER, decision));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "invalid_target_stage" });
  });

  test("nested principal on the decision payload is ignored; only the top-level stamp counts", () => {
    const state = withOpenReview();
    const decision = { ...approveD1(), principalId: OWNER };
    const next = applyDecision(input(state, "intruder", decision));
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "unauthorized" });
  });
});

describe("applyDecision open_review/approve/send-back/reapprove lifecycle", () => {
  test("open_review opens the current stage's review with a deterministic reviewId", () => {
    const state = baseState();
    const next = applyDecision(input(state, OWNER, openD1()));
    expect(next.reviews[1]).toMatchObject({ reviewId: "stage-1-review-1", status: "open", sha256: STAGE1_SHA });
    expect(next.decisions[0]).toMatchObject({ accepted: true, kind: "open_review" });
  });

  test("a second open_review replaces the first, staling it", () => {
    const opened = withOpenReview();
    const reopened = applyDecision(
      input(opened, OWNER, { decisionId: "d1b", kind: "open_review", projectId: "p1", stage: 1, artifactId: "p1-stage-1-artifact", version: 2, sha256: "sha-stage-1-v2", at: AT }),
    );
    expect(reopened.reviews[1]).toMatchObject({ reviewId: "stage-1-review-2", version: 2, status: "open" });
  });

  test("approve pins the review approved and advances to the next stage", () => {
    const opened = withOpenReview();
    const next = applyDecision(input(opened, OWNER, approveD1()));
    expect(next.stage).toBe(2);
    expect(next.reviews[1]).toMatchObject({ status: "approved" });
    expect(next.reviews[2]).toBeUndefined();
    expect(next.decisions.at(-1)).toMatchObject({ accepted: true, kind: "approve" });
  });

  test("send back 2 -> 1 marks stage 2 stale; a fresh stage-1 review must be opened before reapproving", () => {
    const afterApprove = applyDecision(input(withOpenReview(), OWNER, approveD1()));
    const stage2Sha = "sha-stage-2-v1";
    const openStage2 = applyDecision(
      input(afterApprove, OWNER, { decisionId: "d3", kind: "open_review", projectId: "p1", stage: 2, artifactId: "p1-stage-2-artifact", version: 1, sha256: stage2Sha, at: AT }),
    );
    const sendBack = {
      decisionId: "d4",
      kind: "send_back",
      projectId: "p1",
      stage: 2,
      targetStage: 1,
      reason: "needs rework",
      at: AT,
    };
    const afterSendBack = applyDecision(input(openStage2, OWNER, sendBack));

    expect(afterSendBack.stage).toBe(1);
    expect(afterSendBack.reviews[2]).toMatchObject({ status: "stale" });
    expect(afterSendBack.reviews[1]).toMatchObject({ status: "stale" });
    expect(afterSendBack.decisions).toHaveLength(4);
    expect(afterSendBack.decisions.at(-1)).toMatchObject({ decisionId: "d4", accepted: true, kind: "send_back" });

    // The old stage-1 reviewId is now stale -- reapproving against it is refused.
    const refusedOld = applyDecision(input(afterSendBack, OWNER, { ...approveD1(), decisionId: "d-old-review" }));
    expect(refusedOld.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stale_review" });

    // Open a fresh stage-1 review and reapprove against it.
    const reopened = applyDecision(
      input(afterSendBack, OWNER, { decisionId: "d5", kind: "open_review", projectId: "p1", stage: 1, artifactId: "p1-stage-1-artifact", version: 2, sha256: "sha-stage-1-v2", at: AT }),
    );
    const reapprove = { decisionId: "d6", kind: "approve", projectId: "p1", stage: 1, reviewId: "stage-1-review-2", artifactId: "p1-stage-1-artifact", version: 2, sha256: "sha-stage-1-v2", at: AT };
    const afterReapprove = applyDecision(input(reopened, OWNER, reapprove));
    expect(afterReapprove.stage).toBe(2);
    expect(afterReapprove.reviews[1]).toMatchObject({ status: "approved" });
    expect(afterReapprove.reviews[2]).toMatchObject({ status: "stale" });

    // Reopen stage 2 and finally approve, completing the project.
    const reopenedStage2 = applyDecision(
      input(afterReapprove, OWNER, { decisionId: "d7", kind: "open_review", projectId: "p1", stage: 2, artifactId: "p1-stage-2-artifact", version: 2, sha256: "sha-stage-2-v2", at: AT }),
    );
    const finalApprove = { decisionId: "d8", kind: "approve", projectId: "p1", stage: 2, reviewId: "stage-2-review-2", artifactId: "p1-stage-2-artifact", version: 2, sha256: "sha-stage-2-v2", at: AT };
    const done = applyDecision(input(reopenedStage2, OWNER, finalApprove));
    expect(done.done).toBe(true);
    expect(done.reviews[2]).toMatchObject({ status: "approved" });
  });

  test("send_back at the last stage with no targetStage defaults to the previous stage", () => {
    const opened = withOpenReview();
    const afterApprove = applyDecision(input(opened, OWNER, approveD1()));
    const openStage2 = applyDecision(
      input(afterApprove, OWNER, { decisionId: "d3", kind: "open_review", projectId: "p1", stage: 2, artifactId: "p1-stage-2-artifact", version: 1, sha256: "sha-stage-2-v1", at: AT }),
    );
    const sendBack = { decisionId: "d4", kind: "send_back", projectId: "p1", stage: 2, reason: "reject delivery", at: AT };
    const next = applyDecision(input(openStage2, OWNER, sendBack));
    expect(next.stage).toBe(1);
    expect(next.decisions.at(-1)).toMatchObject({ accepted: true, targetStage: 1 });
  });
});
