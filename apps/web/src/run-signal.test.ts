import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { approveSignal } from "@solutions-builder/app/workflows/stage-loop";
import { createHubTransport } from "./hub.ts";
import type { StageStatus } from "./run-fold.ts";
import {
  approvalCommand,
  deliverGate,
  gateSignalName,
  sendStageMail,
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

  test("the browser transport calls the hub's own path directly", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await signalRun({ tenantId: "tnt_ws", anchorRunId: "dep_1", signalName: "stage-1-round", signalId: "sig_1" }, createHubTransport());
      expect(urls).toEqual(["/api/tenants/tnt_ws/workflows/dep_1/signals"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("gate = wait + named signal", () => {
  test("AC4: the stage-9 (final) gate maps to its named signal", () => {
    for (const command of ["delivery.accept", "delivery.reject", "delivery.revise"] as const) {
      expect(gateSignalName(9, command)).toBe(approveSignal(9));
    }
  });

  test("the approval a stage leaves by is the ledger's: cost at 7, the draft before it", () => {
    expect(approvalCommand(7)).toBe("cost.approve");
    expect(approvalCommand(3)).toBe("stage.approve");
    expect(gateSignalName(7, "cost.approve")).toBe(approveSignal(7));
  });

  test("stage.submit lands on the same gate signal as the decision that follows it", () => {
    expect(gateSignalName(3, "stage.submit")).toBe(approveSignal(3));
    expect(gateSignalName(3, "stage.approve")).toBe(approveSignal(3));
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
  test("build.cancel lands on the stage-8 gate through the hub, not a host command", async () => {
    const { calls, transport } = recording();
    await deliverGate(PROJECT, 8, null, { command: "build.cancel", runId: "run_8", reason: "stop" }, transport);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/tenants/tnt_ws/workflows/dep_1/signals");
    expect(calls[0]!.body).toMatchObject({ signalName: approveSignal(8), payload: { command: "build.cancel", runId: "run_8" } });
  });
});

describe("sendStageMail", () => {
  test("sends the stage intent as JSON conversation mail to the run, and mirrors it to Sent", async () => {
    const calls: Call[] = [];
    const transport: Transport = {
      fetch: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
        return (path.endsWith("/mail") ? { runId: "dep_1", address: "dep_1@tenant.local", messageId: "msg_1" } : undefined) as T;
      },
      subscribe: () => () => undefined,
    };
    const trigger = await sendStageMail(
      PROJECT,
      { stage: 6, command: "stage.draft", runId: "run_1", message: "write it up", documents: ["plan"] },
      transport,
    );
    expect(trigger.address).toBe("dep_1@tenant.local");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/tenants/tnt_ws/workflows/dep_1/mail",
      body: { content: JSON.stringify({ stage: 6, command: "stage.draft", runId: "run_1", message: "write it up", documents: ["plan"] }) },
    });
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/api/me/inbox/send",
      body: {
        to: ["dep_1@tenant.local"],
        subject: "stage.draft",
        body: JSON.stringify({ stage: 6, command: "stage.draft", runId: "run_1", message: "write it up", documents: ["plan"] }),
      },
    });
  });

  test("a project without a placed run has no specialist to message", async () => {
    const { transport } = recording();
    await expect(
      sendStageMail({ tenantId: "tnt_ws", anchorRunId: null }, { stage: 1, command: "stage.draft", runId: "r", message: "" }, transport),
    ).rejects.toThrow(/not placed/);
  });
});

describe("submitThen", () => {
  test("submits then decides, both landing on the stage's own gate signal", async () => {
    const { calls, transport } = recording();
    const delivered = await submitThen(
      PROJECT,
      3,
      null,
      { runId: "run_1", versions: [] },
      { command: "stage.approve", runId: "run_1", versions: [] },
      transport,
    );
    expect(delivered.map((entry) => entry.signalName)).toEqual([approveSignal(3), approveSignal(3)]);
    expect(calls.map((call) => (call.body as { payload: { command: string } }).payload.command)).toEqual(["stage.submit", "stage.approve"]);
  });

  test("a stage already at its gate is not submitted again", async () => {
    const { calls, transport } = recording();
    await submitThen(PROJECT, 5, parked(5, approveSignal(5)), { runId: "run_5", versions: [] }, { command: "audience.decide", runId: "run_5", audienceName: "Finance", decision: "proceed" }, transport);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { payload: { command: string } }).payload.command).toBe("audience.decide");
  });
});
