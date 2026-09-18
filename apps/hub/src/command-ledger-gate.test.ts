import { describe, expect, test } from "bun:test";
import { ledgerEntryFromGateSignal, selectAdmittedGateSignals } from "./command-ledger.js";

const APPROVE_3 = "solutions-builder.stage.3.approve";
const ROUND_8 = "solutions-builder.stage.8.round";

describe("ledgerEntryFromGateSignal", () => {
  test("a thin intent lands where the ledger row says, at the stage the signal names", async () => {
    const entry = await ledgerEntryFromGateSignal({
      projectId: "tnt_1",
      command: "stage.approve",
      payload: { command: "stage.approve", runId: "run_1", versions: [{ versionId: "v1" }], principalId: "p_person" },
      signalId: "sig_approve",
      signalName: APPROVE_3,
    });
    expect(entry).toMatchObject({
      command: "stage.approve",
      runId: "run_1",
      stage: 3,
      before: { runId: "run_1", stage: 3, state: "waiting_approval" },
      after: { runId: "run_1", stage: 4, state: "in_progress" },
      versions: [{ versionId: "v1" }],
    });
    expect(entry?.result).toMatchObject({ stage: 4, state: "in_progress", transitionId: "stage.approve", delivery: "delivered" });
  });

  test("AC6: the actor is the principal the hub stamped, never one the body claims", async () => {
    const entry = await ledgerEntryFromGateSignal({
      projectId: "tnt_1",
      command: "stage.submit",
      payload: { runId: "run_1", principalId: "p_hub_says", actorPrincipalId: "p_body_says", actor: { principalId: "p_also_body" } },
      signalId: "sig_submit",
      signalName: "solutions-builder.stage.1.round",
    });
    expect(entry?.actorPrincipalId).toBe("p_hub_says");
  });

  test("AC2: idempotency is the signalId — a body idempotencyKey is not read", async () => {
    const args = {
      projectId: "tnt_1",
      command: "stage.approve" as const,
      payload: { runId: "run_1", idempotencyKey: "idem-body", expectedRevision: 7 },
      signalId: "sig_approve",
      signalName: APPROVE_3,
    };
    const entry = await ledgerEntryFromGateSignal(args);
    expect(entry?.idempotencyKey).toBe("sig_approve");
    expect(entry?.correlationId).toBe("sig_approve");
  });

  test("a route back lands on the target the person named", async () => {
    const entry = await ledgerEntryFromGateSignal({
      projectId: "tnt_1",
      command: "stage.revise",
      payload: { runId: "run_1", targetStage: 2, reason: "again" },
      signalId: "sig_revise",
      signalName: "solutions-builder.stage.4.approve",
    });
    expect(entry?.after).toEqual({ runId: "run_1", stage: 2, state: "backtracked" });
  });

  test("build.cancel on the stage-8 round is a recorded build decision", async () => {
    const entry = await ledgerEntryFromGateSignal({
      projectId: "tnt_1",
      command: "build.cancel",
      payload: { runId: "run_8", reason: "stop" },
      signalId: "sig_cancel",
      signalName: ROUND_8,
    });
    expect(entry?.after).toEqual({ runId: "run_8", stage: 8, state: "cancelled" });
  });

  test("a signal that names no run or is not a stage's is skipped", async () => {
    expect(
      await ledgerEntryFromGateSignal({ projectId: "tnt_1", command: "stage.submit", payload: { command: "stage.submit" }, signalId: "s", signalName: APPROVE_3 }),
    ).toBeNull();
    expect(
      await ledgerEntryFromGateSignal({ projectId: "tnt_1", command: "stage.submit", payload: { runId: "run_1" }, signalId: "s", signalName: "other.signal" }),
    ).toBeNull();
  });
});

describe("selectAdmittedGateSignals", () => {
  const received = (seq: number, signalId: string, command: string, signalName = APPROVE_3) => ({
    seq,
    type: "SignalReceived",
    body: { signalName, signalId, payload: { command, runId: "run_1" } },
  });

  test("AC2: the same signalId committed twice (awaiter and relay) is one gate", () => {
    const selected = selectAdmittedGateSignals([
      { runId: "anchor", awaited: new Set(), events: [received(5, "sig_1", "stage.approve")] },
      { runId: "anchor__gate-3__0", awaited: new Set(), events: [received(2, "sig_1", "stage.approve")] },
    ]);
    expect(selected).toHaveLength(1);
  });

  test("build.cancel and build.interrupt on the round are admitted gates; a re-parked (refused) delivery is not", () => {
    const selected = selectAdmittedGateSignals([
      {
        runId: "anchor",
        awaited: new Set(),
        events: [
          received(1, "sig_cancel", "build.cancel", ROUND_8),
          received(2, "sig_interrupt", "build.interrupt", ROUND_8),
          received(3, "sig_refused", "stage.approve"),
          { seq: 4, type: "SignalAwaited", body: { signalName: APPROVE_3 } },
        ],
      },
    ]);
    expect(selected.map((event) => event.body.signalId)).toEqual(["sig_cancel", "sig_interrupt"]);
  });
});
