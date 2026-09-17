import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createHubTransport } from "./hub.ts";
import { signalRun } from "./run-signal.ts";

describe("signalRun", () => {
  test("delivers the signal to the hub workflow path, not a host command route", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const transport: Transport = {
      fetch: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
        return undefined as T;
      },
      subscribe: () => () => undefined,
    };

    await signalRun(
      {
        tenantId: "tnt_ws",
        anchorRunId: "dep_1",
        signalName: "stage-1-approve",
        signalId: "cmd_1",
        payload: { rationale: "ship it" },
      },
      transport,
    );

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/tenants/tnt_ws/workflows/dep_1/signals",
        body: {
          runId: "dep_1",
          signalName: "stage-1-approve",
          signalId: "cmd_1",
          payload: { rationale: "ship it" },
        },
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
      await signalRun(
        {
          tenantId: "tnt_ws",
          anchorRunId: "dep_1",
          signalName: "stage-1-round",
          signalId: "sig_1",
        },
        createHubTransport(),
      );
      expect(urls).toEqual(["/hub/api/tenants/tnt_ws/workflows/dep_1/signals"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
