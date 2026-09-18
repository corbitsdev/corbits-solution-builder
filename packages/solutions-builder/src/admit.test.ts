import { describe, expect, test } from "bun:test";
import { admit, admitGate, gateRunView } from "./admit.js";
import { FORBIDDEN } from "./ledger.js";

describe("admit", () => {
  test("refuses stage.approve at stage 7 — FORBIDDEN stage.approve", () => {
    const rule = FORBIDDEN.find((entry) => entry.command === "stage.approve");
    const verdict = admit({ command: "stage.approve", runId: "run_1", stage: 7, gate: "gate" });
    expect(verdict.refused).toBe(true);
    if (verdict.refused) {
      expect(verdict.code).toBe("forbidden");
      expect(verdict.message).toContain("cost.approve");
      expect(rule?.when).toContain("stage 7");
    }
  });

  test("admits cost.approve at gate 7 and stage.approve at gate 3", () => {
    const cost = admit({ command: "cost.approve", runId: "run_1", stage: 7, gate: "gate" });
    expect(cost.refused).toBe(false);
    const approve = admit({ command: "stage.approve", runId: "run_1", stage: 3, gate: "exhausted" });
    expect(approve).toMatchObject({ refused: false, toStage: 4 });
  });

  test("the evidence park admits accept and fail against a running build", () => {
    expect(gateRunView("run_8", 8, "evidence")).toMatchObject({ kind: "build", stage: 8, state: "running" });
    expect(admit({ command: "build.accept_evidence", runId: "run_8", stage: 8, gate: "evidence" })).toMatchObject({
      refused: false,
      toStage: 9,
    });
    expect(admit({ command: "build.fail", runId: "run_8", stage: 8, gate: "evidence" }).refused).toBe(false);
  });

  test("AC4: stage 9 decides on delivered bytes — delivery.accept is admitted, stage.approve is not", () => {
    expect(gateRunView("run_9", 9, "gate").state).toBe("delivery_review");
    expect(admit({ command: "delivery.accept", runId: "run_9", stage: 9, gate: "gate" }).refused).toBe(false);
    expect(admit({ command: "stage.approve", runId: "run_9", stage: 9, gate: "gate" })).toMatchObject({
      refused: true,
      code: "wrong_state",
    });
  });

  test("a route back names a stage no later than the gate's", () => {
    expect(admit({ command: "stage.revise", runId: "run_1", stage: 4, gate: "gate", targetStage: 2 })).toMatchObject({
      refused: false,
      toStage: 2,
    });
    expect(admit({ command: "stage.revise", runId: "run_1", stage: 4, gate: "gate", targetStage: 6 })).toMatchObject({
      refused: true,
      code: "invalid_route",
    });
  });

  test("stage 5 approval waits on the carried audience tally", () => {
    const before = admit({ command: "stage.approve", runId: "run_5", stage: 5, gate: "gate", quorum: 1 });
    expect(before).toMatchObject({ refused: true, code: "quorum_not_met" });

    const recorded = admit({
      command: "audience.decide",
      runId: "run_5",
      stage: 5,
      gate: "gate",
      quorum: 1,
      audienceName: "Finance",
      decision: "proceed",
    });
    expect(recorded).toMatchObject({
      refused: true,
      code: "recorded",
      audience: { proceeded: 1, blocked: 0, decided: ["Finance"] },
    });

    const again = admit({
      command: "audience.decide",
      runId: "run_5",
      stage: 5,
      gate: "gate",
      quorum: 1,
      audience: recorded.audience,
      audienceName: "Finance",
      decision: "reject",
    });
    expect(again).toMatchObject({ refused: true, code: "forbidden" });

    const after = admit({
      command: "stage.approve",
      runId: "run_5",
      stage: 5,
      gate: "gate",
      quorum: 1,
      audience: recorded.audience,
    });
    expect(after).toMatchObject({ refused: false, toStage: 6 });
  });
});

describe("admitGate", () => {
  /** What the workflow merges for the admit: the intent, then the gate's literals last. */
  const input = (intent: Record<string, unknown>, literal: Record<string, unknown> = { stage: 3, gate: "gate" }) => ({
    ...intent,
    ...literal,
  });

  test("AC3: a stale or already-decided gate is refused by the guard, never by body fields", async () => {
    // The gate stands at stage 7; the intent's own idea of the stage and revision is not read.
    const stale = await admitGate(
      input({ command: "stage.approve", runId: "run_1", stage: 3, expectedRevision: 4 }, { stage: 7, gate: "gate" }),
    );
    expect(stale).toMatchObject({ refused: true, code: "forbidden" });
    const wrongGate = await admitGate(input({ command: "cost.approve", runId: "run_1" }, { stage: 3, gate: "gate" }));
    expect(wrongGate).toMatchObject({ refused: true, code: "forbidden" });
  });

  test("AC6: authority is the delivery, not client-sent context", async () => {
    const bare = await admitGate(input({ command: "stage.approve", runId: "run_1" }));
    const claimed = await admitGate(
      input({
        command: "stage.approve",
        runId: "run_1",
        context: { actorAuthorities: [] },
        actorAuthorities: [],
        run: { id: "run_1", kind: "stage", stage: 9, state: "delivered", originId: "run_1" },
      }),
    );
    expect(bare).toMatchObject({ refused: false, toStage: 4 });
    expect(claimed).toEqual(bare);
  });

  test("a gate that did not say where it stands refuses rather than guessing", async () => {
    expect(await admitGate({ command: "stage.approve", runId: "run_1" })).toMatchObject({ refused: true, code: "wrong_state" });
    expect(await admitGate(input({ runId: "run_1" }))).toMatchObject({ refused: true, code: "unknown_command" });
    expect(await admitGate(input({ command: "stage.approve" }))).toMatchObject({ refused: true, code: "unknown_command" });
  });
});
