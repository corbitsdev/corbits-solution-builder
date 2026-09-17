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

  test("reads every run under the deployment and folds the same events", async () => {
    const transport = transportFor({
      dep_1: [{ seq: 1, type: "RunStarted", body: { at: AT } }],
      "dep_1__child": [{ seq: 1, type: "RunStarted", body: { at: "2026-01-01T00:00:01.000Z" } }],
    });
    const folded = await foldProjectRuns("tnt_ws", "dep_1", transport);
    expect(folded.map((run) => run.runId)).toEqual(["dep_1", "dep_1__child"]);
    expect(folded[0]?.lastAt).toBe(Date.parse(AT));
    expect(await foldProject("tnt_ws", "dep_1", transport)).toBeNull();
  });

  test("an in-flight stage step is standing, not parked", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepStarted", body: { at: AT, stepId: "revise-1", attempt: 1, input: { ref: "inline:null" } } },
      ],
    });
    const standing = await foldProject("tnt_ws", "dep_1", transport);
    expect(standing).toEqual({
      stage: 1,
      stepId: "revise-1",
      parked: false,
      signalName: null,
      since: AT,
    });
    expect(runIsDrafting(standing)).toBe(true);
  });

  test("a parked gate is standing, not drafting", async () => {
    const transport = transportFor({
      dep_1: [
        { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
        { seq: 2, type: "StepStarted", body: { at: AT, stepId: "gate-1", attempt: 1, input: { ref: "inline:null" } } },
        { seq: 3, type: "SignalAwaited", body: { at: AT, stepId: "gate-1", signalName: "stage.approve-1" } },
      ],
    });
    const standing = await foldProject("tnt_ws", "dep_1", transport);
    expect(standing).toEqual({
      stage: 1,
      stepId: "gate-1",
      parked: true,
      signalName: "stage.approve-1",
      since: AT,
    });
    expect(runIsDrafting(standing)).toBe(false);
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
        { seq: 2, type: "StepStarted", body: { at: AT, stepId: "revise-2", attempt: 1, input: { ref: "inline:null" } } },
      ],
    });
    const standing = await standingForProject({ tenantId: "tnt_ws", anchorRunId: "dep_1" }, transport);
    expect(standing?.stepId).toBe("revise-2");
    expect(standing?.parked).toBe(false);
    expect(runIsDrafting(standing)).toBe(true);
  });
});

describe("runIsDrafting", () => {
  test("nothing folded is not drafting", () => {
    expect(runIsDrafting(null)).toBe(false);
  });
});
