import { describe, expect, test } from "bun:test";
import { admit, admitGate } from "./admit.js";
import { FORBIDDEN } from "./ledger.js";
import type { RunView } from "./guard.js";
import type { RunEvent } from "./project-state.js";

function runView(overrides: Partial<RunView> & Pick<RunView, "kind" | "stage" | "state">): RunView {
  return {
    id: "run_1",
    originId: "run_1",
    routeTargetStage: null,
    costApprovalVersionId: null,
    checkpointRef: null,
    ...overrides,
  };
}

/** A committed event list the fold accepts; empty of parks so stage comes from the signal. */
const events: readonly RunEvent[] = [
  { seq: 1, type: "RunStarted", body: { at: "2026-01-01T00:00:00.000Z" } },
];

describe("admit", () => {
  test("refuses a second freeze for the same source — FORBIDDEN build.freeze", () => {
    const rule = FORBIDDEN.find((entry) => entry.command === "build.freeze");
    const verdict = admit(events, {
      command: "build.freeze",
      run: runView({
        kind: "stage",
        stage: 7,
        state: "cost_approved",
        costApprovalVersionId: "ver_cost",
      }),
      context: { actorAuthorities: ["project_owner"], frozenPacketExists: true },
    });
    expect(verdict.refused).toBe(true);
    if (verdict.refused) {
      expect(verdict.code).toBe("forbidden");
      expect(rule).toBeDefined();
      expect(verdict.message).toBe(rule!.reason);
    }
  });

  test("refuses stage.approve at stage 7 — FORBIDDEN stage.approve", () => {
    const rule = FORBIDDEN.find((entry) => entry.command === "stage.approve");
    const verdict = admit(events, {
      command: "stage.approve",
      run: runView({ kind: "stage", stage: 7, state: "waiting_approval" }),
      context: { actorAuthorities: ["project_owner"] },
    });
    expect(verdict.refused).toBe(true);
    if (verdict.refused) {
      expect(verdict.code).toBe("forbidden");
      expect(verdict.message).toContain("cost.approve");
      expect(rule?.when).toContain("stage 7");
    }
  });

  test("refuses build.answer when the waiting request has another origin — FORBIDDEN build.answer", () => {
    const rule = FORBIDDEN.find((entry) => entry.command === "build.answer");
    const verdict = admit(events, {
      command: "build.answer",
      run: runView({ kind: "build", stage: 8, state: "waiting_human", originId: "run_origin" }),
      context: { actorAuthorities: ["project_owner"], waitingRequestOriginId: "run_other" },
    });
    expect(verdict.refused).toBe(true);
    if (verdict.refused) {
      expect(verdict.code).toBe("origin_mismatch");
      expect(rule).toBeDefined();
      expect(verdict.message).toBe(rule!.reason);
    }
  });

  test("admitGate writes a refused step output, not a host run mutation", async () => {
    const output = await admitGate({
      command: "stage.approve",
      run: runView({ kind: "stage", stage: 7, state: "waiting_approval" }),
      context: { actorAuthorities: ["project_owner"] },
      events,
    });
    expect(output.refused).toBe(true);
  });
});
