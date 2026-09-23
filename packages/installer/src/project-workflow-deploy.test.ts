import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { ensureProjectWorkflow, findProjectWorkflow, projectWorkflowAssetName } from "./project-workflow-deploy.js";

const TENANT_ID = "tnt_1";
const PROJECT_ID = "proj_1";
const ASSET_ID = "asset_1";

type Event = { seq: number; type: string; body: Record<string, unknown> };
type Fixture = {
  assets?: { id: string; name: string }[];
  deployments?: { id: string; definitionAssetId: string; status: string; createdAt: string }[];
  runsByDeployment?: Record<string, string[]>;
  /** Each run's event log, by run id; a run left out has an empty log. */
  eventsByRun?: Record<string, Event[]>;
};

const decision = (n: number): Event => ({
  seq: n + 1,
  type: "SignalReceived",
  body: { signalName: "project.decision", signalId: `dec-${String(n)}`, payload: { decision: { decisionId: `dec-${String(n)}`, kind: "approve", stage: n } } },
});
const STARTED: Event = { seq: 1, type: "RunStarted", body: {} };
const PARKED: Event[] = [STARTED, { seq: 2, type: "SignalAwaited", body: { signalName: "project.decision" } }];
const DECIDED: Event[] = [STARTED, decision(1), decision(2)];

/**
 * A hub with just enough state to be deployed to: `POST /deployments`
 * makes `dep_new`, a trigger makes `run_new` (started), and a signal lands
 * on the run it names as a `SignalReceived` event, the way the real hub's
 * event log would show it once the sidecar took it. Every POST is logged.
 */
function fakeHub(fixture: Fixture) {
  const deployments = (fixture.deployments ?? []).map((entry) => ({ ...entry, tenantId: TENANT_ID }));
  const runsByDeployment: Record<string, string[]> = { ...fixture.runsByDeployment };
  const eventsByRun: Record<string, Event[]> = Object.fromEntries(Object.entries(fixture.eventsByRun ?? {}).map(([id, events]) => [id, [...events]]));
  const posts: { path: string; body: unknown }[] = [];
  let pushedTree: Record<string, string> = {};
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const [pathname, query] = path.split("?");
      const tenant = `/api/tenants/${TENANT_ID}`;
      if (method === "POST") posts.push({ path: pathname!, body });
      if (method === "GET" && pathname === tenant) return { id: TENANT_ID } as T;
      if (method === "GET" && pathname === `${tenant}/assets`) {
        return (fixture.assets ?? []).map((asset) => ({ ...asset, tenantId: TENANT_ID, kind: "workflow" })) as T;
      }
      if (method === "GET" && pathname === `${tenant}/workflows/deployments`) return deployments as T;
      if (method === "POST" && pathname === `${tenant}/workflows/deployments`) {
        const made = { id: "dep_new", tenantId: TENANT_ID, definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-02-01T00:00:00.000Z" };
        deployments.push(made);
        runsByDeployment.dep_new = [];
        return made as T;
      }
      if (method === "GET" && pathname === `${tenant}/catalog/offerings`) return { data: [{ id: "off_1", priority: 0, disabled: false }], nextCursor: null } as T;
      if (method === "POST" && /git-tokens$/.test(pathname!)) return { id: "gtk_1", secret: "git-token", expiresAt: "2099-01-01T00:00:00.000Z" } as T;
      if (method === "DELETE" && /git-tokens\//.test(pathname!)) return undefined as T;
      if (method === "GET" && pathname === `${tenant}/assets/${ASSET_ID}/blob`) {
        const wanted = new URLSearchParams(query).get("path") ?? "";
        const content = pushedTree[wanted];
        if (content === undefined) throw Object.assign(new Error("not found"), { status: 404 });
        return { content: btoa(content) } as T;
      }
      const runs = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/runs$/.exec(pathname!);
      if (method === "GET" && runs) return { runIds: runsByDeployment[runs[1]!] ?? [] } as T;
      const events = /^\/api\/tenants\/[^/]+\/workflows\/[^/]+\/runs\/([^/]+)\/events$/.exec(pathname!);
      if (method === "GET" && events) return { runId: events[1], events: eventsByRun[events[1]!] ?? [] } as T;
      const trigger = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/mail$/.exec(pathname!);
      if (method === "POST" && trigger) {
        runsByDeployment[trigger[1]!] = [...(runsByDeployment[trigger[1]!] ?? []), "run_new"];
        eventsByRun.run_new = [STARTED];
        return { runId: "run_new", address: "run_new@hub", messageId: "msg_1" } as T;
      }
      const signal = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/signals$/.exec(pathname!);
      if (method === "POST" && signal) {
        const input = body as { runId: string; signalName: string; signalId: string; payload: unknown };
        const log = (eventsByRun[input.runId] ??= []);
        log.push({ seq: log.length + 1, type: "SignalReceived", body: { signalName: input.signalName, signalId: input.signalId, payload: input.payload } });
        return undefined as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
  const gitPush = async ({ tree }: { tree: Readonly<Record<string, string>> }) => {
    pushedTree = { ...tree };
    return "commit_1";
  };
  return { transport, gitPush, posts, signalsSent: () => posts.filter((post) => /\/signals$/.test(post.path)).map((post) => post.body as { runId: string; signalName: string; signalId: string; payload: unknown }) };
}

const ensure = (hub: ReturnType<typeof fakeHub>) =>
  ensureProjectWorkflow(hub.transport, { canPlaceSidecars: true }, { files: { "workflow.js": "", "actions.js": "", "loops.js": "" } }, hub.gitPush, TENANT_ID, PROJECT_ID, [], {});

const withAsset = (fixture: Omit<Fixture, "assets">): Fixture => ({ assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }], ...fixture });

describe("findProjectWorkflow", () => {
  test("no asset yet -> null", async () => {
    expect(await findProjectWorkflow(fakeHub({}).transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("asset exists but no deployment matches it -> null", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_other", definitionAssetId: "asset_other", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }] }));
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("deployment exists but no top-level run has been triggered -> null", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_1: [] } }));
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });

  test("several top-level runs already exist -> picks the oldest, the same winner every caller converges on", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
        // Iteration children (contain `__`) are excluded; only bare ids count.
        runsByDeployment: { dep_1: ["run_b", "run_a__rework__1", "run_c", "run_a"] },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_1", runId: "run_a" });
  });

  // CL-8867: a dead deployment's run still holds the project's history. A
  // newer live deployment only speaks for the project once it has received
  // every decision that history holds; before that, reading it is how a
  // restart used to reset a project to stage 1.
  test("keeps the dead deployment's run while a newer live run has not caught up with its decisions", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_new_live: ["run_1"], dep_old_failed: ["run_0"] },
        eventsByRun: { run_0: DECIDED, run_1: PARKED },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_old_failed", runId: "run_0" });
  });

  test("a live run that holds every decision the dead one took is the project's run", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_new_live: ["run_1"], dep_old_failed: ["run_0", "run_0__rework__0"] },
        eventsByRun: { run_0: PARKED, run_0__rework__0: DECIDED, run_1: DECIDED },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_new_live", runId: "run_1" });
  });

  test("passes over a failed deployment whose run never took a decision", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_new_live: ["run_1"], dep_old_failed: ["run_0", "run_0__rework__0"] },
        eventsByRun: { run_0: PARKED, run_0__rework__0: PARKED, run_1: PARKED },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_new_live", runId: "run_1" });
  });

  test("only a failed deployment whose run never took a decision -> null, so the project deploys afresh", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_old_failed: ["run_0"] }, eventsByRun: { run_0: PARKED } }));
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toBeNull();
  });
});

describe("ensureProjectWorkflow", () => {
  test("a live run that has caught up is returned as is: nothing pushed, deployed, triggered or signalled", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_1: ["run_1"] }, eventsByRun: { run_1: DECIDED } }));
    expect(await ensure(hub)).toEqual({ deploymentId: "dep_1", runId: "run_1" });
    expect(hub.posts).toEqual([]);
  });

  // The stop of a host leaves the hub reporting a project's deployment
  // failed, and a failed deployment is never placed, fired or signalled
  // again. The run there still holds the project's decisions, so a fresh
  // deployment is triggered and brought up to them, in their original
  // order and under their original ids, before anything reads it.
  test("revives a dead deployment's run: deploys afresh, triggers, and replays every decision in order", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_1: ["run_1", "run_1__rework__0", "run_1__rework__1"] },
        eventsByRun: { run_1: PARKED, run_1__rework__0: [STARTED, decision(1)], run_1__rework__1: [STARTED, decision(2)] },
      }),
    );
    expect(await ensure(hub)).toEqual({ deploymentId: "dep_new", runId: "run_new" });
    expect(hub.signalsSent()).toEqual([
      { runId: "run_new", signalName: "project.decision", signalId: "dec-1", payload: decision(1).body.payload },
      { runId: "run_new", signalName: "project.decision", signalId: "dec-2", payload: decision(2).body.payload },
    ]);
    // And from then on, every reader converges on the revived run.
    expect(await findProjectWorkflow(hub.transport, TENANT_ID, PROJECT_ID)).toEqual({ deploymentId: "dep_new", runId: "run_new" });
  });

  test("a live run that has not caught up is brought up to the dead run's decisions, not replaced", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_old_failed: ["run_0"], dep_new_live: ["run_1"] },
        eventsByRun: { run_0: DECIDED, run_1: [STARTED, decision(1)] },
      }),
    );
    expect(await ensure(hub)).toEqual({ deploymentId: "dep_new_live", runId: "run_1" });
    expect(hub.signalsSent().map((sent) => sent.signalId)).toEqual(["dec-2"]);
  });

  test("deploys afresh when the only deployment has ended and its run never took a decision", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_1: ["run_1"] }, eventsByRun: { run_1: PARKED } }));
    expect(await ensure(hub)).toEqual({ deploymentId: "dep_new", runId: "run_new" });
    expect(hub.signalsSent()).toEqual([]);
  });
});
