import { describe, expect, test } from "bun:test";
import { foldRun, projectTitle, type RunEvent } from "./project-state.js";
import { NAME_STEP_ID } from "./workflows/stage-ids.js";

const RUN_ID = "run-1";

/** A minimal run event log: the run starts, the namer step runs, then completes. */
function eventsWithNamerOutput(reply: unknown): RunEvent[] {
  return [
    {
      seq: 1,
      type: "RunStarted",
      body: { runId: RUN_ID, definitionHash: "hash", trigger: { type: "mail", payload: {} }, at: "2026-01-01T00:00:00.000Z" },
    },
    {
      seq: 2,
      type: "StepStarted",
      body: { stepId: NAME_STEP_ID, attempt: 1, input: { ref: "inline:{}" }, at: "2026-01-01T00:00:01.000Z" },
    },
    {
      seq: 3,
      type: "StepCompleted",
      body: {
        stepId: NAME_STEP_ID,
        attempt: 1,
        output: { ref: `inline:${JSON.stringify({ reply })}` },
        at: "2026-01-01T00:00:02.000Z",
      },
    },
  ];
}

describe("projectTitle", () => {
  test("yields the namer step's completed output, trimmed", () => {
    const run = foldRun(RUN_ID, eventsWithNamerOutput("  Loan Servicing Portal  "));
    expect(projectTitle([run])).toBe("Loan Servicing Portal");
  });

  test("is null before the namer step has completed", () => {
    const run = foldRun(RUN_ID, eventsWithNamerOutput("Anything").slice(0, 2));
    expect(projectTitle([run])).toBeNull();
  });

  test("is null when the completed output has no usable reply", () => {
    const run = foldRun(RUN_ID, eventsWithNamerOutput("   "));
    expect(projectTitle([run])).toBeNull();
  });

  test("is null when no run carries the namer step", () => {
    const run = foldRun(RUN_ID, [
      {
        seq: 1,
        type: "RunStarted",
        body: { runId: RUN_ID, definitionHash: "hash", trigger: { type: "mail", payload: {} }, at: "2026-01-01T00:00:00.000Z" },
      },
    ]);
    expect(projectTitle([run])).toBeNull();
  });
});
