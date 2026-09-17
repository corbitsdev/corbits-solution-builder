import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { foldProject, foldProjectRuns } from "./run-fold.ts";

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

describe("foldProject", () => {
  test("an anchor with no runs has no stage status", async () => {
    const transport = transportFor({});
    expect(await foldProject("tnt_ws", "dep_1", transport)).toBeNull();
    expect(await foldProjectRuns("tnt_ws", "dep_1", transport)).toEqual([]);
  });

  test("reads every run under the deployment and folds the same events", async () => {
    const transport = transportFor({
      dep_1: [{ seq: 1, type: "RunStarted", body: { at: "2026-01-01T00:00:00.000Z" } }],
      "dep_1__child": [{ seq: 1, type: "RunStarted", body: { at: "2026-01-01T00:00:01.000Z" } }],
    });
    const folded = await foldProjectRuns("tnt_ws", "dep_1", transport);
    expect(folded.map((run) => run.runId)).toEqual(["dep_1", "dep_1__child"]);
    expect(folded[0]?.lastAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(await foldProject("tnt_ws", "dep_1", transport)).toBeNull();
  });
});
