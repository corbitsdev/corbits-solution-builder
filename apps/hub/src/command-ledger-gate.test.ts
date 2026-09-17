import { describe, expect, test } from "bun:test";
import { ledgerEntryFromGateSignal, recordGatesFromRunEvents } from "./command-ledger.js";

describe("ledgerEntryFromGateSignal", () => {
  test("builds a ledger entry for a delivered gate without commandFrom", () => {
    const entry = ledgerEntryFromGateSignal({
      projectId: "proj_1",
      command: "stage.submit",
      payload: { runId: "run_1", actorPrincipalId: "p_actor" },
      signalId: "sig_submit",
      expectedStage: 1,
    });
    expect(entry).not.toBeNull();
    expect(entry?.command).toBe("stage.submit");
    expect(entry?.idempotencyKey).toBe("sig_submit");
    expect(entry?.actorPrincipalId).toBe("p_actor");
    expect(entry?.runId).toBe("run_1");
    expect(entry?.result.delivery).toBe("delivered");
  });

  test("builds an entry for a commandFrom-shaped payload (run + context)", () => {
    const entry = ledgerEntryFromGateSignal({
      projectId: "proj_1",
      command: "stage.submit",
      payload: {
        runId: "run_1",
        run: { id: "run_1", kind: "stage", stage: 1, state: "in_progress", originId: "run_1" },
        context: { actorAuthorities: ["project_owner"] },
        actorPrincipalId: "p_actor",
      },
      signalId: "sig_admit",
    });
    expect(entry).not.toBeNull();
    expect(entry?.command).toBe("stage.submit");
    expect(entry?.runId).toBe("run_1");
    expect(entry?.idempotencyKey).toBe("sig_admit");
    expect(entry?.before).toEqual({ runId: "run_1", stage: 1, state: "in_progress" });
  });

  test("skips alignment signals that do not name a run", () => {
    expect(
      ledgerEntryFromGateSignal({
        projectId: "proj_1",
        command: "stage.submit",
        payload: { command: "stage.submit", draft: false },
        signalId: "sig_align",
      }),
    ).toBeNull();
  });

  test("a second delivery with the same key names the same idempotency key", () => {
    const args = {
      projectId: "proj_1",
      command: "stage.approve" as const,
      payload: { runId: "run_1", idempotencyKey: "idem-approve", actorPrincipalId: "p_actor" },
      signalId: "sig_approve",
    };
    const first = ledgerEntryFromGateSignal(args);
    const second = ledgerEntryFromGateSignal(args);
    expect(first?.idempotencyKey).toBe("idem-approve");
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });
});

describe("recordGatesFromRunEvents", () => {
  test("a committed SignalReceived that never went through commandFrom names a gate entry", () => {
    const events = [
      {
        type: "SignalReceived",
        body: {
          signalName: "solutions-builder.stage.1.approve",
          signalId: "client-sig-1",
          payload: { command: "stage.approve", runId: "run_1", actorPrincipalId: "p_actor" },
        },
      },
      { type: "StepStarted", body: { stepId: "admit" } },
    ];
    const received = events.filter((event) => event.type === "SignalReceived");
    expect(received).toHaveLength(1);
    const payload = received[0]!.body.payload as Record<string, unknown>;
    const entry = ledgerEntryFromGateSignal({
      projectId: "proj_1",
      command: payload.command as "stage.approve",
      payload,
      signalId: received[0]!.body.signalId as string,
    });
    expect(entry?.command).toBe("stage.approve");
    expect(entry?.idempotencyKey).toBe("client-sig-1");
    expect(typeof recordGatesFromRunEvents).toBe("function");
  });
});
