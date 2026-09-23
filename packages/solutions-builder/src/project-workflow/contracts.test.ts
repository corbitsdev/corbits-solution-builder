import { describe, expect, test } from "bun:test";
import { applyDecision, initProjectState, type ApplyDecisionInput, type ProjectState } from "./contracts.js";
import type { StackRecord } from "../stack.js";

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

describe("mint_requirements", () => {
  const mintDecision = (id: string) => ({
    decisionId: id,
    kind: "mint_requirements",
    projectId: "p1",
    stage: 1,
    items: [
      { kind: "FR", text: "Does a thing." },
      { kind: "FR", text: "Does another thing." },
      { kind: "AC", text: "Proves it." },
    ],
    at: AT,
  });

  test("mints deterministic per-kind ids in order, without advancing the stage", () => {
    const state = baseState();
    const next = applyDecision(input(state, OWNER, mintDecision("m1")));
    expect(next.requirements).toEqual([
      { id: "FR-1", kind: "FR", text: "Does a thing." },
      { id: "FR-2", kind: "FR", text: "Does another thing." },
      { id: "AC-1", kind: "AC", text: "Proves it." },
    ]);
    expect(next.stage).toBe(state.stage);
    expect(next.decisions.at(-1)).toMatchObject({ accepted: true, kind: "mint_requirements" });
  });

  test("minting twice is refused", () => {
    const minted = applyDecision(input(baseState(), OWNER, mintDecision("m1")));
    const again = applyDecision(input(minted, OWNER, mintDecision("m2")));
    expect(again.requirements).toEqual(minted.requirements);
    expect(again.decisions.at(-1)).toMatchObject({ accepted: false, reason: "requirements_already_minted" });
  });

  test("a send-back to stage <= 6 clears minted requirements", () => {
    const minted = applyDecision(input(baseState(), OWNER, mintDecision("m1")));
    const opened = applyDecision(input(minted, OWNER, openD1()));
    const sendBack = { decisionId: "sb1", kind: "send_back", projectId: "p1", stage: 1, targetStage: 1, reason: "revise", at: AT };
    const next = applyDecision(input(opened, OWNER, sendBack));
    expect(next.requirements).toEqual([]);
  });
});

describe("stage7Rule stack citations", () => {
  const OWNER7 = "owner7";

  function baseState7(): ProjectState {
    return initProjectState({
      projectId: "p1",
      stages: [1, 2, 3, 4, 5, 6, 7].map((stage) => ({ stage, authorizedPrincipalIds: [OWNER7] })),
    });
  }

  /** Walks stages 1..6 open_review/approve with no stage rule involved
   *  (5 and 6 carry no `evidence` here on purpose -- 5's own quorum rule is
   *  exercised elsewhere), landing at stage 7 with `state.requirements` set. */
  function stateAtStage7(requirements: { kind: "FR" | "NFR" | "IR" | "AC"; text: string }[]): ProjectState {
    let state = baseState7();
    state = applyDecision(input(state, OWNER7, { decisionId: "mint", kind: "mint_requirements", projectId: "p1", stage: 1, items: requirements, at: AT }));
    for (const stage of [1, 2, 3, 4]) {
      state = applyDecision(
        input(state, OWNER7, { decisionId: `o${String(stage)}`, kind: "open_review", projectId: "p1", stage, artifactId: `a${String(stage)}`, version: 1, sha256: `s${String(stage)}`, at: AT }),
      );
      state = applyDecision(
        input(state, OWNER7, { decisionId: `ap${String(stage)}`, kind: "approve", projectId: "p1", stage, reviewId: `stage-${String(stage)}-review-1`, artifactId: `a${String(stage)}`, version: 1, sha256: `s${String(stage)}`, at: AT }),
      );
    }
    // Stage 5 needs its policy captured (solo, 0 required) to advance.
    state = applyDecision(
      input(state, OWNER7, {
        decisionId: "o5",
        kind: "open_review",
        projectId: "p1",
        stage: 5,
        artifactId: "a5",
        version: 1,
        sha256: "s5",
        at: AT,
        policy: { quorum: 0, stakeholders: [] },
      }),
    );
    state = applyDecision(
      input(state, OWNER7, {
        decisionId: "ap5",
        kind: "approve",
        projectId: "p1",
        stage: 5,
        reviewId: "stage-5-review-1",
        artifactId: "a5",
        version: 1,
        sha256: "s5",
        at: AT,
      }),
    );
    for (const stage of [6]) {
      state = applyDecision(
        input(state, OWNER7, { decisionId: `o${String(stage)}`, kind: "open_review", projectId: "p1", stage, artifactId: `a${String(stage)}`, version: 1, sha256: `s${String(stage)}`, at: AT }),
      );
      state = applyDecision(
        input(state, OWNER7, { decisionId: `ap${String(stage)}`, kind: "approve", projectId: "p1", stage, reviewId: `stage-${String(stage)}-review-1`, artifactId: `a${String(stage)}`, version: 1, sha256: `s${String(stage)}`, at: AT }),
      );
    }
    return state;
  }

  function frozenFrom(state: ProjectState) {
    return [1, 2, 3, 4, 5, 6].map((stage) => ({
      stage,
      artifactId: state.reviews[stage]!.artifactId,
      version: state.reviews[stage]!.version,
      sha256: state.reviews[stage]!.sha256,
    }));
  }

  const STACK: StackRecord = {
    mode: "plain",
    runtime: { choice: "TypeScript", reason: "matches the rubric", cites: ["FR-1"] },
    ui: null,
    storage: null,
    auth: null,
    packaging: { choice: "cli", reason: "matches the rubric", cites: ["FR-1"], kind: "cli" },
    packages: [],
    deferred: [],
  };

  test("approve is refused stack_missing when evidence carries no stack", () => {
    const state = stateAtStage7([{ kind: "FR", text: "Does a thing." }]);
    const opened = applyDecision(
      input(state, OWNER7, { decisionId: "o7", kind: "open_review", projectId: "p1", stage: 7, artifactId: "a7", version: 1, sha256: "s7", at: AT }),
    );
    const next = applyDecision(
      input(opened, OWNER7, {
        decisionId: "ap7",
        kind: "approve",
        projectId: "p1",
        stage: 7,
        reviewId: "stage-7-review-1",
        artifactId: "a7",
        version: 1,
        sha256: "s7",
        at: AT,
        evidence: { target: "cli", frozen: frozenFrom(state) },
      }),
    );
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stack_missing" });
    expect(next.freeze).toBeNull();
  });

  test("approve is refused stack_uncited when an entry cites nothing", () => {
    const state = stateAtStage7([{ kind: "FR", text: "Does a thing." }]);
    const opened = applyDecision(
      input(state, OWNER7, { decisionId: "o7", kind: "open_review", projectId: "p1", stage: 7, artifactId: "a7", version: 1, sha256: "s7", at: AT }),
    );
    const next = applyDecision(
      input(opened, OWNER7, {
        decisionId: "ap7",
        kind: "approve",
        projectId: "p1",
        stage: 7,
        reviewId: "stage-7-review-1",
        artifactId: "a7",
        version: 1,
        sha256: "s7",
        at: AT,
        evidence: { target: "cli", frozen: frozenFrom(state), stack: { ...STACK, runtime: { ...STACK.runtime, cites: [] } } },
      }),
    );
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stack_uncited" });
  });

  test("approve is refused stack_unknown_requirement when a citation names an id that does not exist", () => {
    const state = stateAtStage7([{ kind: "FR", text: "Does a thing." }]);
    const opened = applyDecision(
      input(state, OWNER7, { decisionId: "o7", kind: "open_review", projectId: "p1", stage: 7, artifactId: "a7", version: 1, sha256: "s7", at: AT }),
    );
    const next = applyDecision(
      input(opened, OWNER7, {
        decisionId: "ap7",
        kind: "approve",
        projectId: "p1",
        stage: 7,
        reviewId: "stage-7-review-1",
        artifactId: "a7",
        version: 1,
        sha256: "s7",
        at: AT,
        evidence: { target: "cli", frozen: frozenFrom(state), stack: { ...STACK, runtime: { ...STACK.runtime, cites: ["FR-99"] } } },
      }),
    );
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "stack_unknown_requirement" });
  });

  test("approve freezes the stack, keyed to the minted requirement ids, when every citation is valid", () => {
    const state = stateAtStage7([{ kind: "FR", text: "Does a thing." }]);
    const opened = applyDecision(
      input(state, OWNER7, { decisionId: "o7", kind: "open_review", projectId: "p1", stage: 7, artifactId: "a7", version: 1, sha256: "s7", at: AT }),
    );
    const next = applyDecision(
      input(opened, OWNER7, {
        decisionId: "ap7",
        kind: "approve",
        projectId: "p1",
        stage: 7,
        reviewId: "stage-7-review-1",
        artifactId: "a7",
        version: 1,
        sha256: "s7",
        at: AT,
        evidence: { target: "cli", frozen: frozenFrom(state), stack: STACK },
      }),
    );
    expect(next.decisions.at(-1)).toMatchObject({ accepted: true, kind: "approve" });
    expect(next.freeze).toMatchObject({ target: "cli", stack: STACK });
  });
});

describe("stage 5 audience decisions (CL-8870)", () => {
  const OWNER5 = "owner5";

  function baseState5(): ProjectState {
    return initProjectState({ projectId: "p1", stages: [{ stage: 5, authorizedPrincipalIds: [OWNER5] }] });
  }

  function openReview5(policy?: { quorum: number; stakeholders: string[] }, decisionId = "o5", artifactId = "a5", version = 1, sha256 = "s5"): ProjectState {
    return reopen5(baseState5(), policy, decisionId, artifactId, version, sha256);
  }

  function reopen5(
    state: ProjectState,
    policy?: { quorum: number; stakeholders: string[] },
    decisionId = "o5",
    artifactId = "a5",
    version = 1,
    sha256 = "s5",
  ): ProjectState {
    return applyDecision(
      input(state, OWNER5, {
        decisionId,
        kind: "open_review",
        projectId: "p1",
        stage: 5,
        artifactId,
        version,
        sha256,
        at: AT,
        ...(policy ? { policy } : {}),
      }),
    );
  }

  function vote(state: ProjectState, decisionId: string, audience: string, decision: string): ProjectState {
    return applyDecision(input(state, OWNER5, { decisionId, kind: "audience", projectId: "p1", stage: 5, audience, decision, at: AT }));
  }

  function approve5(state: ProjectState, decisionId: string, reviewId = "stage-5-review-1", artifactId = "a5", version = 1, sha256 = "s5"): ProjectState {
    return applyDecision(input(state, OWNER5, { decisionId, kind: "approve", projectId: "p1", stage: 5, reviewId, artifactId, version, sha256, at: AT }));
  }

  test("a vote is tallied", () => {
    const state = vote(openReview5({ quorum: 2, stakeholders: ["alice", "bob"] }), "v1", "alice", "proceed");
    expect(state.audienceDecisions["alice"]).toMatchObject({ audience: "alice", decision: "proceed", decisionId: "v1" });
    expect(state.decisions.at(-1)).toMatchObject({ accepted: true, kind: "audience", audience: "alice", outcome: "proceed" });
  });

  test("a repeated signal (same decisionId) is deduped and does not change the recorded vote", () => {
    let state = vote(openReview5({ quorum: 2, stakeholders: ["alice", "bob"] }), "v1", "alice", "proceed");
    const before = state.decisions.length;
    state = vote(state, "v1", "alice", "reject");
    expect(state.decisions).toHaveLength(before + 1);
    expect(state.decisions.at(-1)).toMatchObject({ decisionId: "v1", accepted: false, reason: "duplicate" });
    expect(state.audienceDecisions["alice"]).toMatchObject({ decision: "proceed" });
  });

  test("the latest vote per stakeholder wins", () => {
    let state = openReview5({ quorum: 1, stakeholders: ["alice"] });
    state = vote(state, "v1", "alice", "reject");
    state = vote(state, "v2", "alice", "proceed");
    expect(state.audienceDecisions["alice"]).toMatchObject({ decision: "proceed", decisionId: "v2" });
  });

  test("approve is refused below quorum and accepted once it is met", () => {
    let state = openReview5({ quorum: 2, stakeholders: ["alice", "bob"] });
    state = vote(state, "v1", "alice", "proceed");
    const short = approve5(state, "ap1");
    expect(short.decisions.at(-1)).toMatchObject({ accepted: false, reason: "quorum_not_met" });
    expect(short.decisions.at(-1)).toMatchObject({ quorum: { proceeded: 1, required: 2, blocked: [] } });

    state = vote(state, "v2", "bob", "proceed");
    const met = approve5(state, "ap2");
    expect(met.decisions.at(-1)).toMatchObject({ accepted: true, kind: "approve" });
    expect(met.done).toBe(true);
  });

  test("a blocking vote refuses approve even once the proceed count is met", () => {
    let state = openReview5({ quorum: 1, stakeholders: ["alice", "bob"] });
    state = vote(state, "v1", "alice", "proceed");
    state = vote(state, "v2", "bob", "reject");
    const next = approve5(state, "ap1");
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "quorum_not_met" });
  });

  // CL-8870 scope addition: the policy is captured once, by the `open_review`
  // that opens a stage-5 review -- nothing else can touch it, so a client
  // that edits the stakeholder list after the review is open can never
  // change the gate that review is checked against.
  test("the quorum policy is captured on open_review, immune to anything but a fresh open_review", () => {
    let state = openReview5({ quorum: 2, stakeholders: ["alice", "bob"] });
    expect(state.audiencePolicy).toEqual({ quorum: 2, stakeholders: ["alice", "bob"] });
    state = vote(state, "v1", "alice", "proceed");
    state = vote(state, "v2", "bob", "proceed");
    // Nothing but a fresh open_review can change the captured policy.
    expect(state.audiencePolicy).toEqual({ quorum: 2, stakeholders: ["alice", "bob"] });
    expect(approve5(state, "ap1").decisions.at(-1)).toMatchObject({ accepted: true });
  });

  test("re-opening the review (a redraft) recaptures the policy in effect at that moment", () => {
    let state = openReview5({ quorum: 1, stakeholders: ["alice"] });
    state = vote(state, "v1", "alice", "proceed");
    // The stakeholder list changed; the next open_review (a new package
    // version) carries the new policy.
    state = reopen5(state, { quorum: 2, stakeholders: ["alice", "carol"] }, "o5b", "a5", 2, "s5b");
    expect(state.audiencePolicy).toEqual({ quorum: 2, stakeholders: ["alice", "carol"] });
    // Alice's earlier vote still counts (latest per audience, by name), but
    // carol has not voted, so the new policy's quorum is not met.
    const next = approve5(state, "ap1", "stage-5-review-2", "a5", 2, "s5b");
    expect(next.decisions.at(-1)).toMatchObject({ accepted: false, reason: "quorum_not_met" });
  });
});
