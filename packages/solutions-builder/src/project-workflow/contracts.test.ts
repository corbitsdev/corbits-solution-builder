import { describe, expect, test } from "bun:test";
import {
  applyDecision,
  contentSha256,
  initProjectState,
  type ApplyDecisionInput,
  type ProjectState,
  type ReadArtifact,
} from "./contracts.js";

const OWNER = "owner-principal";
const STAGE1_CONTENT = "stage 1 content";
const STAGE1_SHA = contentSha256(STAGE1_CONTENT);

function baseState(): ProjectState {
  return initProjectState({
    projectId: "p1",
    stages: [
      { stage: 1, authorizedPrincipalIds: [OWNER] },
      { stage: 2, authorizedPrincipalIds: [OWNER] },
    ],
    firstReview: { reviewId: "stage-1-review-1", artifactId: "p1-stage-1-artifact", version: 1 },
  });
}

const readArtifact: ReadArtifact = async (artifactId, version) => {
  if (artifactId === "p1-stage-1-artifact" && version === 1) return { content: STAGE1_CONTENT };
  return null;
};

function input(state: ProjectState, principalId: unknown, decision: unknown): ApplyDecisionInput {
  return { ...state, principalId, decision };
}

function approveD1(): Record<string, unknown> {
  return {
    decisionId: "d1",
    projectId: "p1",
    stage: 1,
    reviewId: "stage-1-review-1",
    artifactId: "p1-stage-1-artifact",
    version: 1,
    sha256: STAGE1_SHA,
    outcome: "approve",
  };
}

describe("applyDecision refusals leave state unchanged", () => {
  test("missing top-level principal", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, undefined, approveD1()), readArtifact);
    expect(next).toEqual(state);
  });

  test("invalid shape", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { not: "a decision" }), readArtifact);
    expect(next).toEqual(state);
  });

  test("unauthorized principal", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, "intruder", approveD1()), readArtifact);
    expect(next.stage).toBe(state.stage);
    expect(next.reviews).toEqual(state.reviews);
    expect(next.decisions).toHaveLength(1);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "unauthorized" });
  });

  test("wrong project", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { ...approveD1(), projectId: "other" }), readArtifact);
    expect(next.stage).toBe(state.stage);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "wrong_project" });
  });

  test("wrong stage", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { ...approveD1(), stage: 2 }), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "wrong_stage" });
  });

  test("stale reviewId", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { ...approveD1(), reviewId: "old-review" }), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "stale_review" });
  });

  test("wrong artifact", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { ...approveD1(), artifactId: "other-artifact" }), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "wrong_artifact" });
  });

  test("stale version", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { ...approveD1(), version: 2 }), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "stale_version" });
  });

  test("artifact unreadable", async () => {
    const state = baseState();
    const missing: ReadArtifact = async () => null;
    const next = await applyDecision(input(state, OWNER, approveD1()), missing);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "artifact_unreadable" });
  });

  test("wrong content hash (payload claims a hash the real content doesn't have)", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, { ...approveD1(), sha256: "0".repeat(64) }), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "hash_mismatch" });
  });

  test("wrong content hash even when payload hash matches an already-pinned review hash", async () => {
    // Manufacture a state where the current open review is already pinned to
    // a hash that does NOT match the real artifact content -- the reducer
    // must still recompute and refuse, never trusting the pinned value alone.
    const state = baseState();
    const pinned: ProjectState = {
      ...state,
      reviews: { ...state.reviews, 1: { ...state.reviews[1]!, sha256: "stale-pin-hash" } },
    };
    const next = await applyDecision(input(pinned, OWNER, { ...approveD1(), sha256: "stale-pin-hash" }), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "hash_mismatch" });
  });

  test("duplicate decisionId leaves state fully unchanged, including decisions", async () => {
    const state = baseState();
    const first = await applyDecision(input(state, "intruder", approveD1()), readArtifact);
    expect(first.decisions).toHaveLength(1);
    const second = await applyDecision(input(first, OWNER, approveD1()), readArtifact);
    expect(second).toEqual(first);
  });

  test("send_back without reason is refused at shape validation", async () => {
    const state = baseState();
    const next = await applyDecision(
      input(state, OWNER, { ...approveD1(), outcome: "send_back", targetStage: 1 }),
      readArtifact,
    );
    expect(next).toEqual(state);
  });

  test("send_back with targetStage above current stage is refused", async () => {
    const state = baseState();
    const decision = { ...approveD1(), stage: 1, outcome: "send_back", targetStage: 2, reason: "not allowed" };
    const next = await applyDecision(input(state, OWNER, decision), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "invalid_target_stage" });
  });

  test("nested principal on the decision payload is ignored; only the top-level stamp counts", async () => {
    const state = baseState();
    const decision = { ...approveD1(), principalId: OWNER };
    const next = await applyDecision(input(state, "intruder", decision), readArtifact);
    expect(next.decisions[0]).toMatchObject({ accepted: false, reason: "unauthorized" });
  });
});

describe("applyDecision approve/send-back/reapprove lifecycle", () => {
  test("approve pins the hash, marks approved, and advances to the next stage", async () => {
    const state = baseState();
    const next = await applyDecision(input(state, OWNER, approveD1()), readArtifact);
    expect(next.stage).toBe(2);
    expect(next.reviews[1]).toMatchObject({ status: "approved", sha256: STAGE1_SHA });
    expect(next.reviews[2]).toMatchObject({ status: "open", sha256: null, reviewId: "stage-2-review-1" });
    expect(next.decisions[0]).toMatchObject({ accepted: true, outcome: "approve" });
  });

  test("send back 2 -> 1 marks stage 2 stale, opens a fresh stage-1 review, keeps decisions", async () => {
    const readTwo: ReadArtifact = async (id, v) => {
      if (id === "p1-stage-1-artifact" && v === 1) return { content: STAGE1_CONTENT };
      if (id === "p1-stage-2-artifact" && v === 1) return { content: "stage 2 content" };
      return null;
    };
    const afterApprove = await applyDecision(input(baseState(), OWNER, approveD1()), readTwo);
    const stage2Sha = contentSha256("stage 2 content");
    const sendBack = {
      decisionId: "d2",
      projectId: "p1",
      stage: 2,
      reviewId: "stage-2-review-1",
      artifactId: "p1-stage-2-artifact",
      version: 1,
      sha256: stage2Sha,
      outcome: "send_back",
      targetStage: 1,
      reason: "needs rework",
    };
    const afterSendBack = await applyDecision(input(afterApprove, OWNER, sendBack), readTwo);

    expect(afterSendBack.stage).toBe(1);
    expect(afterSendBack.reviews[2]).toMatchObject({ status: "stale" });
    expect(afterSendBack.reviews[1]).toMatchObject({ status: "open", sha256: null, reviewId: "stage-1-review-2" });
    expect(afterSendBack.decisions).toHaveLength(2);
    expect(afterSendBack.decisions[0]).toMatchObject({ decisionId: "d1", accepted: true });
    expect(afterSendBack.decisions[1]).toMatchObject({ decisionId: "d2", accepted: true, outcome: "send_back" });

    // The old stage-1 reviewId is now stale -- reapproving against it is refused.
    const oldReview = { ...approveD1(), decisionId: "d-old-review" };
    const refusedOld = await applyDecision(input(afterSendBack, OWNER, oldReview), readTwo);
    expect(refusedOld.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stale_review" });

    // Reapprove against the NEW stage-1 review.
    const readThree: ReadArtifact = async (id, v) => {
      if (id === "p1-stage-1-artifact" && v === 2) return { content: "stage 1 revised" };
      return readTwo(id, v);
    };
    const reapprove = {
      decisionId: "d3",
      projectId: "p1",
      stage: 1,
      reviewId: "stage-1-review-2",
      artifactId: "p1-stage-1-artifact",
      version: 2,
      sha256: contentSha256("stage 1 revised"),
      outcome: "approve",
    };
    const afterReapprove = await applyDecision(input(afterSendBack, OWNER, reapprove), readThree);
    expect(afterReapprove.stage).toBe(2);
    expect(afterReapprove.reviews[1]).toMatchObject({ status: "approved" });
    expect(afterReapprove.reviews[2]).toMatchObject({ status: "open", reviewId: "stage-2-review-2" });

    // Final approve on stage 2 sets done.
    const finalApprove = {
      decisionId: "d4",
      projectId: "p1",
      stage: 2,
      reviewId: "stage-2-review-2",
      artifactId: "p1-stage-2-artifact",
      version: 2,
      sha256: stage2Sha,
      outcome: "approve",
    };
    const readFour: ReadArtifact = async (id, v) => {
      if (id === "p1-stage-2-artifact" && v === 2) return { content: "stage 2 content" };
      return readThree(id, v);
    };
    const done = await applyDecision(input(afterReapprove, OWNER, finalApprove), readFour);
    expect(done.done).toBe(true);
    expect(done.reviews[2]).toMatchObject({ status: "approved" });
  });
});
