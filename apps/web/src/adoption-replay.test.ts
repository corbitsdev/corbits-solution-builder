import { describe, expect, test } from "bun:test";
import { applyDecision, initProjectState, type ProjectState } from "@solutions-builder/app/project-workflow/contracts";
import type { AdoptionPlan } from "@solutions-builder/app/legacy-adoption";
import { replayAdoption, replayedVoteDecisionId } from "./adoption-replay.ts";
import { projectWorkflowViewOf } from "./project-workflow.ts";
import type { StageApprovalDeps } from "./stage-approval.ts";

const PRINCIPAL = "prn_owner";

/** The workflow's own reducer behind the `view`/`decide` pair, applied as the hub would, one decision per signal. */
function workflow(projectId: string, options: { readonly refuse?: (decision: Record<string, unknown>) => boolean } = {}) {
  let state: ProjectState = initProjectState({
    projectId,
    stages: Array.from({ length: 9 }, (_, index) => ({ stage: index + 1, authorizedPrincipalIds: [PRINCIPAL] })),
  });
  const decisions: Record<string, unknown>[] = [];
  const deps: StageApprovalDeps = {
    view: async () => projectWorkflowViewOf(state),
    decide: async (_projectId, decision) => {
      decisions.push(decision);
      // A refusal is the reducer's own: a stranger's decision is recorded as refused.
      state = applyDecision({ ...state, principalId: options.refuse?.(decision) ? "prn_stranger" : PRINCIPAL, decision });
      return { ok: true };
    },
    now: () => "2026-09-23T00:00:00.000Z",
  };
  return { deps, decisions, state: () => state };
}

const ref = (stage: number) => ({ artifactId: `art_${String(stage)}`, version: 2, sha256: `sha_${String(stage)}` });

function plan(overrides: Partial<AdoptionPlan> = {}): AdoptionPlan {
  return {
    projectId: "proj_1",
    legacyStage: 4,
    legacyDone: false,
    steps: [1, 2, 3].map((stage) => ({ stage, ref: ref(stage) })),
    notes: [],
    ...overrides,
  };
}

const fast = { startTimeoutMs: 200, votesTimeoutMs: 200, pollIntervalMs: 5 };

describe("replayAdoption", () => {
  test("opens and approves each step's version in turn and lands one past the last", async () => {
    const wf = workflow("proj_1");
    const outcome = await replayAdoption(wf.deps, plan(), fast);
    expect(outcome).toEqual({ landed: 4, stopped: null });
    expect(wf.state().reviews[3]).toMatchObject({ status: "approved", artifactId: "art_3", version: 2, sha256: "sha_3" });
    expect(wf.decisions.map((decision) => decision["kind"])).toEqual(["open_review", "approve", "open_review", "approve", "open_review", "approve"]);
  });

  test("records stage 5's votes under a fixed decision id, then approves under the quorum policy", async () => {
    const wf = workflow("proj_1");
    const policy = { quorum: 1, stakeholders: ["You", "Brian J. Finance"] };
    const votes = { You: { decision: "proceed" as const, note: "" }, "Brian J. Finance": { decision: "proceed" as const, note: "Within budget." } };
    const outcome = await replayAdoption(
      wf.deps,
      plan({ legacyStage: 6, steps: [...[1, 2, 3, 4].map((stage) => ({ stage, ref: ref(stage) })), { stage: 5, ref: ref(5), policy, votes }] }),
      fast,
    );
    expect(outcome).toEqual({ landed: 6, stopped: null });
    const voted = wf.decisions.filter((decision) => decision["kind"] === "audience");
    expect(voted.map((decision) => decision["decisionId"])).toEqual([replayedVoteDecisionId("proj_1", "You"), replayedVoteDecisionId("proj_1", "Brian J. Finance")]);
    expect(voted[1]).toMatchObject({ audience: "Brian J. Finance", decision: "proceed", note: "Within budget." });
    expect(wf.state().audiencePolicy).toEqual(policy);
  });

  test("mints stage 6's requirements before opening its review", async () => {
    const wf = workflow("proj_1");
    const items = [
      { kind: "FR" as const, text: "Alert on a missed pot." },
      { kind: "NFR" as const, text: "Under one second behind live." },
    ];
    const outcome = await replayAdoption(
      wf.deps,
      plan({
        legacyStage: 7,
        steps: [...[1, 2, 3, 4].map((stage) => ({ stage, ref: ref(stage) })), { stage: 5, ref: ref(5), policy: { quorum: 0, stakeholders: [] }, votes: {} }, { stage: 6, ref: ref(6), requirementItems: items }],
      }),
      fast,
    );
    expect(outcome).toEqual({ landed: 7, stopped: null });
    expect(wf.state().requirements.map((entry) => entry.text)).toEqual(items.map((item) => item.text));
    const kinds = wf.decisions.map((decision) => decision["kind"]);
    expect(kinds.indexOf("mint_requirements")).toBeLessThan(kinds.lastIndexOf("open_review"));
  });

  test("skips steps the workflow is already past, so a second replay changes nothing", async () => {
    const wf = workflow("proj_1");
    await replayAdoption(wf.deps, plan(), fast);
    const before = wf.decisions.length;
    const outcome = await replayAdoption(wf.deps, plan(), fast);
    expect(outcome).toEqual({ landed: 4, stopped: null });
    expect(wf.decisions.length).toBe(before);
  });

  test("stops when a step is ahead of the workflow", async () => {
    const wf = workflow("proj_1");
    const outcome = await replayAdoption(wf.deps, plan({ steps: [{ stage: 1, ref: ref(1) }, { stage: 3, ref: ref(3) }] }), fast);
    expect(outcome).toEqual({ landed: 2, stopped: "the workflow is at stage 2, not 3" });
  });

  test("stops at the first refusal and says which stage", async () => {
    const wf = workflow("proj_1", { refuse: (decision) => decision["kind"] === "open_review" && decision["stage"] === 2 });
    const outcome = await replayAdoption(wf.deps, plan(), fast);
    expect(outcome.landed).toBe(2);
    expect(outcome.stopped).toMatch(/^opening stage 2's review was refused: /);
  });

  test("reports a workflow that never reports a stage", async () => {
    const deps: StageApprovalDeps = { view: async () => null, decide: async () => ({ ok: true }), now: () => "" };
    expect(await replayAdoption(deps, plan(), fast)).toEqual({ landed: null, stopped: "the project's workflow never reported a stage" });
  });
});
