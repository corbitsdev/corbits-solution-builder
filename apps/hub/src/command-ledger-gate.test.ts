import { describe, expect, mock, test } from "bun:test";

const turns: { metadata: Record<string, unknown> }[] = [];

mock.module("./command-dispatch.js", () => ({ HOST_PRINCIPAL: "p_host" }));

mock.module("./hub-client.js", () => ({
  SPECIALIST_PRINCIPAL_ID: "p_specialist",
  definitionIdFor: async () => "def_1",
  ensureAgentSession: async () => undefined,
  ensureSpecialistPrincipal: async () => undefined,
  ensureUserPrincipal: async () => undefined,
  listConversationTurns: async () => turns.map((turn, index) => ({
    id: `part_${index}`,
    content: "",
    metadata: turn.metadata,
    startedAt: "2024-01-01T00:00:00.000Z",
  })),
  localActor: () => ({ principalId: "p_owner", displayName: "You" }),
  tenantId: () => "t_workspace",
  writeConversationTurn: async (args: { metadata: Record<string, unknown> }) => {
    turns.push({ metadata: args.metadata });
    return `turn_${turns.length}`;
  },
}));

const { recordGateFromSignal, recordGatesFromRunEvents, hostRecordsAfterAdmit } = await import("./command-ledger.js");

describe("recordGateFromSignal", () => {
  test("records a ledger turn for a delivered gate without commandFrom", async () => {
    turns.length = 0;
    await recordGateFromSignal({
      projectId: "proj_1",
      command: "stage.submit",
      payload: { runId: "run_1", actorPrincipalId: "p_actor" },
      signalId: "sig_submit",
      expectedStage: 1,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.metadata.kind).toBe("command");
    expect(turns[0]?.metadata.command).toBe("stage.submit");
    expect(turns[0]?.metadata.idempotencyKey).toBe("sig_submit");
    expect(turns[0]?.metadata.actorPrincipalId).toBe("p_actor");
    expect(turns[0]?.metadata.runId).toBe("run_1");
  });

  test("does not dual-write when command-dispatch will record after admit", async () => {
    turns.length = 0;
    const payload = {
      runId: "run_1",
      run: { id: "run_1", kind: "stage", stage: 1, state: "in_progress", originId: "run_1" },
      context: { actorAuthorities: ["project_owner"] },
    };
    expect(hostRecordsAfterAdmit(payload)).toBe(true);
    await recordGateFromSignal({
      projectId: "proj_1",
      command: "stage.submit",
      payload,
      signalId: "sig_admit",
    });
    expect(turns).toHaveLength(0);
  });

  test("skips alignment signals that do not name a run", async () => {
    turns.length = 0;
    await recordGateFromSignal({
      projectId: "proj_1",
      command: "stage.submit",
      payload: { command: "stage.submit", draft: false },
      signalId: "sig_align",
    });
    expect(turns).toHaveLength(0);
  });

  test("a second delivery with the same key does not write another turn", async () => {
    turns.length = 0;
    const args = {
      projectId: "proj_1",
      command: "stage.approve" as const,
      payload: { runId: "run_1", idempotencyKey: "idem-approve" },
      signalId: "sig_approve",
    };
    await recordGateFromSignal(args);
    await recordGateFromSignal(args);
    expect(turns).toHaveLength(1);
  });
});

describe("recordGatesFromRunEvents", () => {
  test("records a committed SignalReceived that never went through commandFrom", async () => {
    turns.length = 0;
    await recordGatesFromRunEvents("proj_1", [
      {
        type: "SignalReceived",
        body: {
          signalName: "solutions-builder.stage.1.approve",
          signalId: "client-sig-1",
          payload: { command: "stage.approve", runId: "run_1", actorPrincipalId: "p_actor" },
        },
      },
      { type: "StepStarted", body: { stepId: "admit" } },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.metadata.command).toBe("stage.approve");
    expect(turns[0]?.metadata.idempotencyKey).toBe("client-sig-1");
  });
});
