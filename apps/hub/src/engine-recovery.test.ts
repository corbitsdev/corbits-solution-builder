import { describe, expect, mock, test } from "bun:test";
import type { CommandInput } from "./engine.js";

const delivered: string[] = [];

mock.module("./lifecycle-run.js", () => ({
  deliverStageSignal: async (
    _projectId: string,
    _command: string,
    _payload: Record<string, unknown>,
    signalId: string,
  ) => {
    delivered.push(signalId);
    return "delivered" as const;
  },
  hasExecution: () => true,
  alignRunWithLedger: async () => "aligned",
  launchProjectLifecycle: async () => undefined,
}));

const { GATE_COMMANDS, runGateSideEffects } = await import("./engine-recovery.js");

function input(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    type: GATE_COMMANDS[0]!,
    actor: { principalId: "p_actor", displayName: "Actor" },
    projectId: "proj_1",
    idempotencyKey: "idem-not-the-signal",
    correlationId: "corr_1",
    payload: {},
    ...overrides,
  };
}

describe("runGateSideEffects", () => {
  test("delivers with a fresh UUID, not the idempotency key", async () => {
    delivered.length = 0;
    const outcome = await runGateSideEffects(input());
    expect(outcome).toBe("delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toBe("idem-not-the-signal");
    expect(delivered[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("accept and fail are delivered as gate commands, not left on gate-8's mapping", () => {
    expect(GATE_COMMANDS).toContain("build.accept_evidence");
    expect(GATE_COMMANDS).toContain("build.fail");
  });
});

describe("engine admit order", () => {
  test("GATE_COMMANDS deliver first; evaluate is not the admit authority; host never writes RunDraft", async () => {
    const source = await Bun.file(new URL("./engine.ts", import.meta.url)).text();
    const deliver = source.indexOf("runGateSideEffects(");
    const verdict = source.indexOf("evaluate(input.type, run, context)");
    const refuse = source.indexOf('if (!verdict.ok && delivery !== "delivered")');
    expect(deliver).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(deliver);
    expect(refuse).toBeGreaterThan(verdict);
    expect(source.search(/new RunDraft\s*\(/)).toBe(-1);
    expect(source).toContain("admitGate` is the admit authority");
  });
});
