import { describe, expect, mock, test } from "bun:test";
import type { CommandInput } from "./command-dispatch.js";

const delivered: string[] = [];
const recorded: { command: string; projectId: string; payload: Record<string, unknown>; signalId: string }[] = [];

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

mock.module("./command-ledger.js", () => ({
  recordGateFromSignal: async (args: {
    command: string;
    projectId: string;
    payload: Record<string, unknown>;
    signalId: string;
  }) => {
    recorded.push(args);
  },
  recordCommand: async () => undefined,
  receiptFor: async () => null,
}));

const { GATE_COMMANDS, runGateSideEffects } = await import("./gate-delivery.js");

function input(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    type: GATE_COMMANDS[0]!,
    actor: { principalId: "p_actor", displayName: "Actor" },
    projectId: "proj_1",
    idempotencyKey: "idem-not-the-signal",
    correlationId: "corr_1",
    payload: { runId: "run_1" },
    ...overrides,
  };
}

describe("runGateSideEffects", () => {
  test("delivers with a fresh UUID, not the idempotency key", async () => {
    delivered.length = 0;
    recorded.length = 0;
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

  test("a delivered gate records a ledger turn without going through api-decisions", async () => {
    delivered.length = 0;
    recorded.length = 0;
    const outcome = await runGateSideEffects(
      input({ type: "stage.submit", payload: { runId: "run_1" } }),
    );
    expect(outcome).toBe("delivered");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.command).toBe("stage.submit");
    expect(recorded[0]?.projectId).toBe("proj_1");
    expect(recorded[0]?.payload.runId).toBe("run_1");
    expect(recorded[0]?.payload.idempotencyKey).toBe("idem-not-the-signal");
    expect(recorded[0]?.payload.actorPrincipalId).toBe("p_actor");
    const source = await Bun.file(new URL("./gate-delivery.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from ["']\.\/api-decisions/);
    expect(source).not.toMatch(/from ["']\.\/api\.js["']/);
  });
});

describe("command-dispatch admit order", () => {
  test("GATE_COMMANDS deliver first; evaluate is not the admit authority; host never writes RunDraft", async () => {
    const source = await Bun.file(new URL("./command-dispatch.ts", import.meta.url)).text();
    const deliver = source.indexOf("runGateSideEffects(");
    const verdict = source.indexOf("evaluate(input.type, run, context)");
    const refuse = source.indexOf('if (!verdict.ok && delivery !== "delivered")');
    expect(deliver).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(deliver);
    expect(refuse).toBeGreaterThan(verdict);
    expect(source.search(/new RunDraft\s*\(/)).toBe(-1);
    const runsSource = await Bun.file(new URL("./runs.ts", import.meta.url)).text();
    expect(runsSource.search(/\bclass RunDraft\b/)).toBe(-1);
    expect(source).toContain("admitGate` is the admit authority");
  });
});

describe("host command routes still exist", () => {
  test("command, submit and decide routes are still registered", async () => {
    const source = await Bun.file(new URL("./api-decisions.ts", import.meta.url)).text();
    expect(source).toContain('api.post("/projects/:projectId/commands/:command"');
    expect(source).toContain('api.post("/projects/:projectId/submit"');
    expect(source).toContain('api.post("/projects/:projectId/decide"');
  });
});
