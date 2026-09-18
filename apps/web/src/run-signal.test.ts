import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { approveSignal, roundSignal } from "@solutions-builder/app/workflows/stage-loop";
import { createHubTransport } from "./hub.ts";
import type { StageStatus } from "./run-fold.ts";
import {
  approvalCommand,
  deliverDraft,
  deliverGate,
  DRAFT_MAX_TOKENS_DEFAULT,
  gateSignalName,
  signalIdFor,
  signalRun,
  submitThen,
} from "./run-signal.ts";

type Call = { method: string; path: string; body?: unknown };

function recording(): { calls: Call[]; transport: Transport } {
  const calls: Call[] = [];
  const transport: Transport = {
    fetch: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      return undefined as T;
    },
    subscribe: () => () => undefined,
  };
  return { calls, transport };
}

const PROJECT = { tenantId: "tnt_ws", anchorRunId: "dep_1" };
const parked = (stage: number, signalName: string): StageStatus => ({
  stage: stage as StageStatus["stage"],
  stepId: `gate-${stage}`,
  parked: true,
  signalName,
  since: null,
});

describe("signalRun", () => {
  test("delivers the signal to the hub workflow path, not a host command route", async () => {
    const { calls, transport } = recording();
    await signalRun(
      { tenantId: "tnt_ws", anchorRunId: "dep_1", signalName: "stage-1-approve", signalId: "cmd_1", payload: { rationale: "ship it" } },
      transport,
    );
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/tenants/tnt_ws/workflows/dep_1/signals",
        body: { runId: "dep_1", signalName: "stage-1-approve", signalId: "cmd_1", payload: { rationale: "ship it" } },
      },
    ]);
    expect(calls.some((call) => /\/(commands|submit|decide)(\/|$)/.test(call.path))).toBe(false);
  });

  test("the browser transport prefixes that path with /hub", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await signalRun({ tenantId: "tnt_ws", anchorRunId: "dep_1", signalName: "stage-1-round", signalId: "sig_1" }, createHubTransport());
      expect(urls).toEqual(["/hub/api/tenants/tnt_ws/workflows/dep_1/signals"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("gate = wait + named signal", () => {
  test("AC4: the stage-9 (final) gate maps to its named signal", () => {
    for (const command of ["delivery.accept", "delivery.reject", "delivery.revise"] as const) {
      expect(gateSignalName(9, command, null)).toBe("solutions-builder.stage.9.approve");
    }
    expect(gateSignalName(9, "delivery.accept", parked(9, "solutions-builder.stage.9.approve-after-exhaustion"))).toBe(
      "solutions-builder.stage.9.approve-after-exhaustion",
    );
  });

  test("the approval a stage leaves by is the ledger's: cost at 7, the draft before it", () => {
    expect(approvalCommand(7)).toBe("cost.approve");
    expect(approvalCommand(3)).toBe("stage.approve");
    expect(gateSignalName(7, "cost.approve", null)).toBe(approveSignal(7));
  });

  test("a parked name for another stage or another park is not borrowed", () => {
    expect(gateSignalName(3, "stage.approve", parked(2, approveSignal(2)))).toBe(approveSignal(3));
    expect(gateSignalName(3, "stage.submit", parked(3, approveSignal(3)))).toBe(roundSignal(3));
  });
});

describe("AC2: the same decision is the same signal", () => {
  test("signalIdFor is a digest of the intent on the gate — a double-click posts one signalId twice", async () => {
    const intent = { command: "stage.approve" as const, runId: "run_1", versions: [{ artifactId: "a", versionId: "v", contentHash: "h" }] };
    const first = await signalIdFor("dep_1", approveSignal(3), intent);
    const second = await signalIdFor("dep_1", approveSignal(3), { ...intent });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await signalIdFor("dep_1", approveSignal(3), { ...intent, runId: "run_2" })).not.toBe(first);
    expect(await signalIdFor("dep_2", approveSignal(3), intent)).not.toBe(first);
  });

  test("deliverGate sent twice is two identical requests: the runtime dedups, the client sends no idempotencyKey", async () => {
    const { calls, transport } = recording();
    const intent = { command: "stage.approve" as const, runId: "run_1", versions: [] };
    await deliverGate(PROJECT, 3, null, intent, transport);
    await deliverGate(PROJECT, 3, null, intent, transport);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("idempotencyKey");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("expectedRevision");
  });
});

describe("AC6: the body is intent, never authority", () => {
  test("the delivered payload carries the command, the run and the decision; no authorities, revision, or tally", async () => {
    const { calls, transport } = recording();
    await deliverGate(
      PROJECT,
      4,
      null,
      { command: "stage.revise", runId: "run_1", reason: "again", targetStage: 2, rationale: "not yet" },
      transport,
    );
    const body = calls[0]!.body as { payload: Record<string, unknown>; signalName: string };
    expect(body.signalName).toBe(approveSignal(4));
    expect(Object.keys(body.payload).sort()).toEqual(["command", "rationale", "reason", "runId", "targetStage"]);
    for (const forbidden of ["actorAuthorities", "context", "run", "audience", "expectedRevision", "principalId"]) {
      expect(body.payload).not.toHaveProperty(forbidden);
    }
  });

  test("a project without a placed run has no gate to decide at", async () => {
    const { transport } = recording();
    await expect(deliverGate({ tenantId: "tnt_ws", anchorRunId: null }, 1, null, { command: "stage.submit", runId: "r" }, transport)).rejects.toThrow(
      /not placed/,
    );
  });
});

describe("AC1: cancel is a signal on the run", () => {
  test("build.cancel lands on the stage-8 round through /hub, not a host command", async () => {
    const { calls, transport } = recording();
    await deliverGate(PROJECT, 8, null, { command: "build.cancel", runId: "run_8", reason: "stop" }, transport);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/tenants/tnt_ws/workflows/dep_1/signals");
    expect(calls[0]!.body).toMatchObject({ signalName: roundSignal(8), payload: { command: "build.cancel", runId: "run_8" } });
  });
});

describe("deliverDraft", () => {
  test("delivers a stage.draft round to the stage's own round signal, not the gate's", async () => {
    const { calls, transport } = recording();
    await deliverDraft(
      PROJECT,
      6,
      {
        command: "stage.draft",
        runId: "run_1",
        message: "write it up",
        mode: "final",
        draft: true,
        inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
        documents: ["plan"],
      },
      transport,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/tenants/tnt_ws/workflows/dep_1/signals");
    const body = calls[0]!.body as { signalName: string; payload: Record<string, unknown> };
    expect(body.signalName).toBe(roundSignal(6));
    expect(body.payload).toEqual({
      command: "stage.draft",
      runId: "run_1",
      message: "write it up",
      mode: "final",
      draft: true,
      inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
      documents: ["plan"],
    });
  });

  test("the same intent sent twice is the same signalId: a retry dedups on the runtime", async () => {
    const { calls, transport } = recording();
    const intent = {
      command: "stage.draft" as const,
      runId: "run_1",
      message: "",
      mode: "final" as const,
      draft: true as const,
      inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
    };
    const first = await deliverDraft(PROJECT, 1, intent, transport);
    const second = await deliverDraft(PROJECT, 1, intent, transport);
    expect(first.signalId).toBe(second.signalId);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
  });

  test("a project without a placed run has no round to draft", async () => {
    const { transport } = recording();
    await expect(
      deliverDraft(
        { tenantId: "tnt_ws", anchorRunId: null },
        1,
        { command: "stage.draft", runId: "r", message: "", mode: "final", draft: true, inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT } },
        transport,
      ),
    ).rejects.toThrow(/not placed/);
  });
});

describe("submitThen", () => {
  test("submits, waits for the gate to park, then decides on the parked gate", async () => {
    const { calls, transport } = recording();
    const folds: (StageStatus | null)[] = [parked(3, roundSignal(3)), parked(3, "solutions-builder.stage.3.approve-after-exhaustion")];
    const delivered = await submitThen(
      PROJECT,
      3,
      parked(3, roundSignal(3)),
      { runId: "run_1", versions: [] },
      { command: "stage.approve", runId: "run_1", versions: [] },
      transport,
      async () => folds.shift() ?? null,
    );
    expect(delivered.map((entry) => entry.signalName)).toEqual([roundSignal(3), "solutions-builder.stage.3.approve-after-exhaustion"]);
    expect(calls.map((call) => (call.body as { payload: { command: string } }).payload.command)).toEqual(["stage.submit", "stage.approve"]);
  });

  test("a stage already at its gate is not submitted again", async () => {
    const { calls, transport } = recording();
    await submitThen(PROJECT, 5, parked(5, approveSignal(5)), { runId: "run_5", versions: [] }, { command: "audience.decide", runId: "run_5", audienceName: "Finance", decision: "proceed" }, transport);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { payload: { command: string } }).payload.command).toBe("audience.decide");
  });
});
