import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { deploymentUsability, pollWhilePlacing, waitForDeploymentDeployed } from "./workflow-deploy.js";

const TENANT_ID = "tnt_1";
type Listed = { id: string; status: string };

/** A hub whose deployment listing answers from a script: `listings[n]` is the
 *  n-th answer, and the last one repeats once the script runs out -- the
 *  hub sitting still. Every answer taken is counted. */
function scriptedHub(listings: readonly (readonly Listed[])[]) {
  let taken = 0;
  const answer = () => {
    const index = Math.min(taken, listings.length - 1);
    taken += 1;
    return listings[index]!.map((entry) => ({ ...entry, tenantId: TENANT_ID, definitionAssetId: "asset_1", createdAt: "2026-01-01T00:00:00.000Z" }));
  };
  const transport: Transport = {
    async fetch<T>(method: string, path: string): Promise<T> {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/workflows/deployments`) return answer() as T;
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
  return { transport, workflows: { deployments: async () => answer() }, taken: () => taken };
}

const FAST = { pollMs: 1 };

// #236: a deployment is handed back only once it can take mail or a signal.
describe("deploymentUsability", () => {
  /** `scriptedHub` plus the anchor run's log, so a placed deployment's run can be read. */
  function hubWithRun(listings: readonly (readonly Listed[])[], events: readonly { seq: number; type: string }[]) {
    const scripted = scriptedHub(listings);
    const transport: Transport = {
      async fetch<T>(method: string, path: string): Promise<T> {
        if (method === "GET" && /\/workflows\/dep_1\/runs\/dep_1\/events$/.test(path)) return { runId: "dep_1", events: events.map((event) => ({ ...event, body: {} })) } as T;
        return scripted.transport.fetch<T>(method, path);
      },
    } as Transport;
    return { transport, taken: scripted.taken };
  }

  test("a placed deployment whose run is parked is usable", async () => {
    const hub = hubWithRun([[{ id: "dep_1", status: "deployed" }]], [{ seq: 1, type: "RunStarted" }, { seq: 2, type: "SignalAwaited" }]);
    expect(await deploymentUsability(hub.transport, TENANT_ID, "dep_1", "dep_1", FAST)).toBe("usable");
  });

  test("a placed deployment whose run has ended is not: mailing it would answer 409", async () => {
    const hub = hubWithRun([[{ id: "dep_1", status: "deployed" }]], [{ seq: 1, type: "RunStarted" }, { seq: 2, type: "RunCompleted" }]);
    expect(await deploymentUsability(hub.transport, TENANT_ID, "dep_1", "dep_1", FAST)).toBe("ended");
  });

  test("a recovering deployment the hub places in time is usable, one that ends is not", async () => {
    const placed = hubWithRun([[{ id: "dep_1", status: "recovering" }], [{ id: "dep_1", status: "deployed" }]], [{ seq: 1, type: "RunStarted" }]);
    expect(await deploymentUsability(placed.transport, TENANT_ID, "dep_1", "dep_1", FAST)).toBe("usable");
    const ended = hubWithRun([[{ id: "dep_1", status: "recovering" }], [{ id: "dep_1", status: "failed" }]], []);
    expect(await deploymentUsability(ended.transport, TENANT_ID, "dep_1", "dep_1", FAST)).toBe("ended");
  });

  test("a recovering deployment the hub sits still on is given up as stalled, within the wait's bound", async () => {
    const hub = hubWithRun([[{ id: "dep_1", status: "recovering" }]], []);
    expect(await deploymentUsability(hub.transport, TENANT_ID, "dep_1", "dep_1", { ...FAST, stallMs: 20 })).toBe("stalled");
  });
});

describe("waitForDeploymentDeployed", () => {
  test("resolves true once the deployment is placed", async () => {
    const hub = scriptedHub([[{ id: "dep_1", status: "pending" }], [{ id: "dep_1", status: "deployed" }]]);
    expect(await waitForDeploymentDeployed(hub.transport, TENANT_ID, "dep_1", FAST)).toBe(true);
    expect(hub.taken()).toBe(2);
  });

  test("a restored deployment reporting `running` counts as placed", async () => {
    const hub = scriptedHub([[{ id: "dep_1", status: "running" }]]);
    expect(await waitForDeploymentDeployed(hub.transport, TENANT_ID, "dep_1", FAST)).toBe(true);
  });

  test("resolves false at once when the deployment has ended", async () => {
    const hub = scriptedHub([[{ id: "dep_1", status: "failed" }]]);
    expect(await waitForDeploymentDeployed(hub.transport, TENANT_ID, "dep_1", { ...FAST, stallMs: 60_000 })).toBe(false);
    expect(hub.taken()).toBe(1);
  });

  test("gives up once the hub has sat still for the stall bound", async () => {
    const hub = scriptedHub([[{ id: "dep_1", status: "pending" }]]);
    const started = Date.now();
    expect(await waitForDeploymentDeployed(hub.transport, TENANT_ID, "dep_1", { ...FAST, stallMs: 30 })).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  test("keeps waiting past the stall bound while the hub is still placing other deployments", async () => {
    // Every listing shows another deployment moving (the hub restoring a
    // project's sidecars in turn after a restart), then this one lands.
    const others = Array.from({ length: 8 }, (_, n) => [
      { id: "dep_1", status: "pending" },
      { id: `dep_other_${String(n)}`, status: n % 2 === 0 ? "recovering" : "deployed" },
    ]);
    const hub = scriptedHub([...others, [{ id: "dep_1", status: "deployed" }]]);
    // Each poll sleeps longer than the stall bound; only the hub's visible
    // moves keep the wait alive.
    expect(await waitForDeploymentDeployed(hub.transport, TENANT_ID, "dep_1", { pollMs: 5, stallMs: 3 })).toBe(true);
    expect(hub.taken()).toBe(others.length + 1);
  });

  test("the ceiling ends the wait however busy the hub stays", async () => {
    let n = 0;
    const busy = { deployments: async () => [{ id: "dep_1", status: "pending" }, { id: `dep_${String((n += 1))}`, status: "pending" }] as never };
    const started = Date.now();
    const found = await pollWhilePlacing(busy, () => null, { pollMs: 2, stallMs: 60_000, ceilingMs: 40 });
    expect(found).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});

describe("pollWhilePlacing", () => {
  test("hands `read` each listing and returns its first non-null result", async () => {
    const hub = scriptedHub([[{ id: "a", status: "pending" }], [{ id: "a", status: "pending" }, { id: "b", status: "pending" }]]);
    const found = await pollWhilePlacing(hub.workflows, (listed) => (listed.length === 2 ? listed.map((entry) => entry.id) : null), FAST);
    expect(found).toEqual(["a", "b"]);
  });

  test("a stall bound of zero reads once and gives up", async () => {
    const hub = scriptedHub([[{ id: "a", status: "pending" }]]);
    expect(await pollWhilePlacing(hub.workflows, () => null, { ...FAST, stallMs: 0 })).toBeNull();
    expect(hub.taken()).toBe(1);
  });
});
