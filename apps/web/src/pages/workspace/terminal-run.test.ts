import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../../client.js";
import { TERMINAL_RUN_NOTICE, isTerminalRunRefusal } from "./terminal-run.ts";

describe("isTerminalRunRefusal", () => {
  test("recognises the hub's code and its sentence, and nothing else", () => {
    expect(isTerminalRunRefusal(new ApiFailure({ code: "workflow_run_terminal", message: "x", correlationId: "-", retryable: false }, 409))).toBe(true);
    expect(isTerminalRunRefusal(new ApiFailure({ code: "conflict", message: "Workflow run run_1 is terminal and cannot receive more mail", correlationId: "-", retryable: false }, 409))).toBe(true);
    expect(isTerminalRunRefusal(new Error("trigger for run_1 answered 409: workflow_run_terminal is terminal and cannot receive more mail"))).toBe(true);
    expect(isTerminalRunRefusal(new ApiFailure({ code: "not_found", message: "no such tenant", correlationId: "-", retryable: false }, 404))).toBe(false);
    expect(isTerminalRunRefusal(null)).toBe(false);
    expect(TERMINAL_RUN_NOTICE).toContain("back in the box");
  });
});
