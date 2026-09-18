import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { foldProject, foldProjectRuns, runIsDrafting, standingForProject } from "./run-fold.ts";

function transportFor(runs: Record<string, { seq: number; type: string; body: Record<string, unknown> }[]>): Transport {
  return {
    fetch: async <T>(_method: string, path: string): Promise<T> => {
      const listed = /\/workflows\/([^/]+)\/runs$/.exec(path);
      if (listed) {
        return { runIds: Object.keys(runs) } as T;
      }
      const events = /\/workflows\/[^/]+\/runs\/([^/]+)\/events$/.exec(path);
      if (events) {
        const runId = events[1]!;
        return { runId, events: runs[runId] ?? [] } as T;
      }
      throw new Error(`unexpected path ${path}`);
    },
    subscribe: () => () => undefined,
  };
}

const AT = "2026-01-01T00:00:00.000Z";

describe("foldProject", () => {
  test("an anchor with no runs has no stage status", async () => {
    const transport = transportFor({});
    expect(await foldProject("tnt_ws", "dep_1", transport)).toBeNull();
    expect(await foldProjectRuns("tnt_ws", "dep_1", transport)).toEqual([]);
  });

  test("before any gate has started, standing is stage 1 with the chat section drafting", async () => {
    const transport = transportFor({
      dep_1: [{ seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } }],
    });
    const standing = await foldProject("tnt_ws", "dep_1", transport);
    expect(standing).toEqual({ stage: 1, stepId: "chat", parked: false, signalName: null, since: null });
    expect(runIsDrafting(standing)).toBe(true);
  });

  test("a parked gate-1 is standing, not drafting", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepStarted", body: { at: AT, stepId: "gate-1", attempt: 1, input: { ref: "inline:null" } } },
        { seq: 3, type: "SignalAwaited", body: { at: AT, stepId: "gate-1", signalName: "solutions-builder.stage.1.approve" } },
      ],
    });
    const standing = await foldProject("tnt_ws", "dep_1", transport);
    expect(standing).toEqual({
      stage: 1,
      stepId: "gate-1",
      parked: true,
      signalName: "solutions-builder.stage.1.approve",
      since: AT,
    });
    expect(runIsDrafting(standing)).toBe(false);
  });

  test("gate-1 approved moves standing to stage 2, drafting again", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepStarted", body: { at: AT, stepId: "gate-1", attempt: 1, input: { ref: "inline:null" } } },
        { seq: 3, type: "SignalAwaited", body: { at: AT, stepId: "gate-1", signalName: "solutions-builder.stage.1.approve" } },
        { seq: 4, type: "SignalReceived", body: { at: AT, stepId: "gate-1", signalName: "solutions-builder.stage.1.approve", payload: { command: "stage.submit" } } },
        { seq: 5, type: "StepCompleted", body: { at: AT, stepId: "gate-1", output: { ref: "inline:{}" } } },
      ],
    });
    const standing = await foldProject("tnt_ws", "dep_1", transport);
    expect(standing).toEqual({ stage: 2, stepId: "chat", parked: false, signalName: null, since: null });
    expect(runIsDrafting(standing)).toBe(true);
  });

  test("a parked freeze reads as stage 7 (cost approved), and evidence as stage 8", async () => {
    const gate7Completed = [
      { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
      { seq: 2, type: "StepCompleted", body: { at: AT, stepId: "gate-7", output: { ref: "inline:{}" } } },
    ];
    const freezeParked = transportFor({
      dep_1: [
        ...gate7Completed,
        { seq: 3, type: "StepStarted", body: { at: AT, stepId: "freeze", attempt: 1 } },
        { seq: 4, type: "SignalAwaited", body: { at: AT, stepId: "freeze", signalName: "solutions-builder.stage.7.freeze" } },
      ],
    });
    expect(await foldProject("tnt_ws", "dep_1", freezeParked)).toEqual({
      stage: 7,
      stepId: "freeze",
      parked: true,
      signalName: "solutions-builder.stage.7.freeze",
      since: AT,
    });

    const evidenceParked = transportFor({
      dep_1: [
        ...gate7Completed,
        { seq: 3, type: "StepCompleted", body: { at: AT, stepId: "freeze", output: { ref: "inline:{}" } } },
        { seq: 4, type: "StepStarted", body: { at: AT, stepId: "evidence", attempt: 1 } },
        { seq: 5, type: "SignalAwaited", body: { at: AT, stepId: "evidence", signalName: "solutions-builder.stage.8.evidence" } },
      ],
    });
    expect(await foldProject("tnt_ws", "dep_1", evidenceParked)).toEqual({
      stage: 8,
      stepId: "evidence",
      parked: true,
      signalName: "solutions-builder.stage.8.evidence",
      since: AT,
    });
  });

  test("delivery-check in flight after gate-8 reads as stage 9, in progress", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepCompleted", body: { at: AT, stepId: "gate-8", output: { ref: "inline:{}" } } },
        { seq: 3, type: "StepStarted", body: { at: AT, stepId: "delivery-check", attempt: 1 } },
      ],
    });
    const standing = await foldProject("tnt_ws", "dep_1", transport);
    expect(standing).toEqual({ stage: 9, stepId: "delivery-check", parked: false, signalName: null, since: AT });
    expect(runIsDrafting(standing)).toBe(true);
  });

  test("delivery-check completed leaves nothing to stand on", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepCompleted", body: { at: AT, stepId: "gate-8", output: { ref: "inline:{}" } } },
        { seq: 3, type: "StepCompleted", body: { at: AT, stepId: "delivery-check", output: { ref: "inline:{}" } } },
      ],
    });
    expect(await foldProject("tnt_ws", "dep_1", transport)).toBeNull();
  });
});

describe("standingForProject", () => {
  test("no anchor means nothing to fold, and does not call the hub", async () => {
    const transport = transportFor({
      dep_1: [{ seq: 1, type: "RunStarted", body: { at: AT } }],
    });
    expect(await standingForProject({ tenantId: "tnt_ws", anchorRunId: null }, transport)).toBeNull();
  });

  test("folds the GET's tenant and anchor, not a host activity field", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepStarted", body: { at: AT, stepId: "gate-2", attempt: 1 } },
        { seq: 3, type: "SignalAwaited", body: { at: AT, stepId: "gate-2", signalName: "solutions-builder.stage.2.approve" } },
      ],
    });
    const standing = await standingForProject({ tenantId: "tnt_ws", anchorRunId: "dep_1" }, transport);
    expect(standing?.stepId).toBe("gate-2");
    expect(standing?.parked).toBe(true);
    expect(runIsDrafting(standing)).toBe(false);
  });
});

describe("runIsDrafting", () => {
  test("nothing folded is not drafting", () => {
    expect(runIsDrafting(null)).toBe(false);
  });
});
