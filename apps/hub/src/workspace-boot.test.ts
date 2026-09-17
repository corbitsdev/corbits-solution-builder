import { describe, expect, test } from "bun:test";
import { hubProxyAllowed } from "./hub-proxy.js";
import { retryEnsureWorkspace } from "./workspace-boot.js";

describe("retryEnsureWorkspace", () => {
  test("returns without sleeping when the first ensure succeeds", async () => {
    let calls = 0;
    let slept = 0;
    await retryEnsureWorkspace(
      async () => {
        calls += 1;
      },
      {
        sleep: async () => {
          slept += 1;
        },
      },
    );
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });

  test("retries a transient failure then succeeds, so listen can proceed", async () => {
    let calls = 0;
    const delays: number[] = [];
    await retryEnsureWorkspace(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("hub not ready");
      },
      {
        attempts: 5,
        delayMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 10]);
  });

  test("throws after exhausting attempts so the host never listens", async () => {
    let calls = 0;
    let listening = false;
    try {
      await retryEnsureWorkspace(
        async () => {
          calls += 1;
          throw new Error("cannot create workspace");
        },
        { attempts: 3, sleep: async () => {} },
      );
      listening = true;
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toContain("will not listen");
      expect((cause as Error).message).toContain("cannot create workspace");
    }
    expect(calls).toBe(3);
    expect(listening).toBe(false);
    // The 403 path the client used to hit is still refused; recovery is boot, not a proxy hole.
    expect(
      hubProxyAllowed("POST", "/api/tenants", { name: "Solutions Builder", slug: "solutions-builder" }),
    ).toBe(false);
  });
});
