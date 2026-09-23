import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { ensureProjectWorkflow, findProjectWorkflow, projectWorkflowAssetName } from "./project-workflow-deploy.js";

const TENANT_ID = "tnt_1";
const PROJECT_ID = "proj_1";
const ASSET_ID = "asset_1";

type Fixture = {
  assets?: { id: string; name: string }[];
  deployments?: { id: string; definitionAssetId: string; status: string; createdAt: string }[];
  runsByDeployment?: Record<string, string[]>;
  /** Each run's event log, by run id; a run left out has an empty log. */
  eventsByRun?: Record<string, { seq: number; type: string; body: Record<string, unknown> }[]>;
};

const DECIDED = [{ seq: 1, type: "RunStarted", body: {} }, { seq: 2, type: "SignalReceived", body: { signalName: "project.decision" } }];
const PARKED = [{ seq: 1, type: "RunStarted", body: {} }, { seq: 2, type: "SignalAwaited", body: { signalName: "project.decision" } }];

function fakeTransport(fixture: Fixture): Transport {
  return {
    async fetch<T>(method: string, path: string): Promise<T> {
      const [pathname] = path.split("?");
      if (method === "GET" && pathname === `/api/tenants/${TENANT_ID}`) {
        return { id: TENANT_ID } as T;
      }
      if (method === "GET" && pathname === `/api/tenants/${TENANT_ID}/assets`) {
        return (fixture.assets ?? []).map((asset) => ({ ...asset, tenantId: TENANT_ID, kind: "workflow" })) as T;
      }
      if (method === "GET" && pathname === `/api/tenants/${TENANT_ID}/workflows/deployments`) {
        return (fixture.deployments ?? []).map((entry) => ({ ...entry, tenantId: TENANT_ID })) as T;
      }
      const runsMatch = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/runs$/.exec(pathname ?? "");
      if (method === "GET" && runsMatch) {
        return { runIds: fixture.runsByDeployment?.[runsMatch[1]!] ?? [] } as T;
      }
      const eventsMatch = /^\/api\/tenants\/[^/]+\/workflows\/[^/]+\/runs\/([^/]+)\/events$/.exec(pathname ?? "");
      if (method === "GET" && eventsMatch) {
        return { runId: eventsMatch[1], events: fixture.eventsByRun?.[eventsMatch[1]!] ?? [] } as T;
      }
      if (method === "POST" && /git-tokens/.test(pathname ?? "")) {
        return { id: "gtk_1", secret: "git-token", expiresAt: "2099-01-01T00:00:00.000Z" } as T;
      }
      if (method === "DELETE" && /git-tokens/.test(pathname ?? "")) {
        return undefined as T; // the push revokes its token on every exit
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("findProjectWorkflow", () => {
  test("no asset yet -> null", async () => {
    const transport = fakeTransport({});
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("asset exists but no deployment matches it -> null", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_other", definitionAssetId: "asset_other", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("deployment exists but no top-level run has been triggered -> null", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: { dep_1: [] },
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("several top-level runs already exist -> picks the oldest, the same winner every caller converges on", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: {
        // Iteration children (contain `__`) are excluded; only bare ids count.
        dep_1: ["run_b", "run_a__rework__1", "run_c", "run_a"],
      },
    });
    const result = await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID);
    expect(result).toEqual({ deploymentId: "dep_1", runId: "run_a" });
  });

  // CL-8867: a host that gets killed outright can leave the hub reporting a
  // project's original deployment not-live (or even permanently failed)
  // well before, or without, the hub's own recovery reconnecting it. That
  // deployment still owns the project's real run and its stage history; a
  // newer deployment made on top of it (a redeploy this project should never
  // have taken) holds an unrelated, freshly-started run. The oldest
  // deployment that actually has a triggered run wins, live or not --
  // reading the newer one's run instead is exactly how a restart used to
  // reset a project back to stage 1.
  test("keeps the project's original run even when its deployment reports not live and a newer deployment exists", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [
        { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
      runsByDeployment: { dep_new_live: ["run_1"], dep_old_failed: ["run_0"] },
      eventsByRun: { run_0: DECIDED },
    });
    const result = await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID);
    expect(result).toEqual({ deploymentId: "dep_old_failed", runId: "run_0" });
  });

  // A deployment the hub has ended for good is one it never places again,
  // so a run parked there can never take another decision. When it never
  // took one at all, its state is the initial state and there is nothing to
  // keep: passing it over is what lets the project deploy afresh instead of
  // sitting at "did not finish starting up" forever.
  test("passes over a failed deployment whose run never took a decision", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [
        { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
      runsByDeployment: { dep_new_live: ["run_1"], dep_old_failed: ["run_0", "run_0__rework__0"] },
      eventsByRun: { run_0: PARKED, run_0__rework__0: PARKED, run_1: DECIDED },
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_new_live", runId: "run_1" });
  });

  test("a decision taken on a loop iteration counts for its failed deployment", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: { dep_old_failed: ["run_0", "run_0__rework__0", "run_0__rework__1"] },
      eventsByRun: { run_0: PARKED, run_0__rework__0: DECIDED, run_0__rework__1: PARKED },
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_old_failed", runId: "run_0" });
  });

  test("only a failed deployment whose run never took a decision -> null, so the project deploys afresh", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: { dep_old_failed: ["run_0"] },
      eventsByRun: { run_0: PARKED },
    });
    expect(await findProjectWorkflow(transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });
});

describe("ensureProjectWorkflow", () => {
  // CL-8867 root cause: `ensureProjectWorkflowOnce` used to redeploy and
  // trigger a brand-new top-level run whenever the picked deployment was
  // not live, even when that deployment already had a run. A host killed
  // outright reports its deployment not-live right after restart, so
  // reopening a project redeployed it and reset it to stage 1. Reusing the
  // existing run means this call must never push source, never deploy and
  // never trigger -- the fake transport throws on any of those routes.
  test("reuses the project's existing run instead of redeploying when its deployment is not live", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: { dep_1: ["run_1"] },
      eventsByRun: { run_1: DECIDED },
    });
    const result = await ensureProjectWorkflow(
      transport,
      { canPlaceSidecars: true },
      { files: { "workflow.js": "", "actions.js": "", "loops.js": "" } },
      async () => {
        throw new Error("must not push a new source tree onto a deployment that already has a run");
      },
      TENANT_ID,
      PROJECT_ID,
      [],
      {},
    );
    expect(result).toEqual({ deploymentId: "dep_1", runId: "run_1" });
  });

  test("redeploys when the only deployment has ended and its run never took a decision", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }],
      deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
      runsByDeployment: { dep_1: ["run_1"] },
      eventsByRun: { run_1: PARKED },
    });
    // Reaching the push at all is the point: a fresh source tree is only
    // pushed on the way to a new deployment, never for a reused run.
    const pushed = ensureProjectWorkflow(
      transport,
      { canPlaceSidecars: true },
      { files: { "workflow.js": "", "actions.js": "", "loops.js": "" } },
      async () => {
        throw new Error("pushed a fresh source tree");
      },
      TENANT_ID,
      PROJECT_ID,
      [],
      {},
    );
    await expect(pushed).rejects.toThrow("pushed a fresh source tree");
  });
});
