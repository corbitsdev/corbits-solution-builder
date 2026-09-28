import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createDecisionMemo, ensureProjectWorkflow, findProjectWorkflow, namerPin, projectWorkflowAssetName, type ProjectWorkflowCode } from "./project-workflow-deploy.js";

const TENANT_ID = "proj_1";
const PROJECT_ID = "proj_1";
const ASSET_ID = "asset_1";

type Event = { seq: number; type: string; body: Record<string, unknown> };
type LedgerRow = { decisionId: string; accepted: boolean; reason?: string; kind: string; stage: number };
/** What the fake hub's reducer says to one replayed decision; accepted when absent. */
type Verdict = { accepted: boolean; reason?: string };
type Fixture = {
  assets?: { id: string; name: string }[];
  deployments?: { id: string; definitionAssetId: string; status: string; createdAt: string }[];
  runsByDeployment?: Record<string, string[]>;
  /** Each run's event log, by run id; a run left out has an empty log. */
  eventsByRun?: Record<string, Event[]>;
  /** Deployments the hub shows from the n-th listing on (1-based), the way
   *  its own replacement of a dead deployment appears seconds after a
   *  restart, or a status changes while it is placing. A deployment listed
   *  again under an id already shown replaces that row. */
  appearAtListing?: Record<number, { deployment: { id: string; definitionAssetId: string; status: string; createdAt: string }; runIds?: string[]; events?: Record<string, Event[]> }[]>;
  /** The new code's reducer, as the fake applies a signal: its verdict on each decision id. */
  reducer?: (decisionId: string) => Verdict;
  /** How many reads of the top-level run's log follow a signal before the
   *  run shows parked again; until then the log ends in the hub-written
   *  `SignalReceived`, the way the real hub's does while the child is still
   *  writing its turn (#188). Absent, the run parks at once. */
  parkAfterReads?: number;
  /** The decision on which the run completes instead of parking again. */
  endsRunOn?: string;
};

const decisionPayload = (n: number) => ({ decision: { decisionId: `dec-${String(n)}`, kind: "approve", stage: n } });
const decision = (n: number): Event => ({
  seq: n + 1,
  type: "SignalReceived",
  body: { signalName: "project.decision", signalId: `dec-${String(n)}`, payload: decisionPayload(n) },
});
/** The `apply` step's committed output: the reducer's state, of which only the ledger is read here. */
const applied = (seq: number, ledger: readonly LedgerRow[]): Event => ({
  seq,
  type: "StepCompleted",
  body: { stepId: "apply", attempt: 1, output: { ref: `inline:${JSON.stringify({ decisions: ledger })}` } },
});
const STARTED: Event = { seq: 1, type: "RunStarted", body: {} };
/** A run triggered the way `ensureProjectWorkflow` triggers one now: with the code it runs on the mail that fired it. */
const startedOn = (code: ProjectWorkflowCode): Event => ({
  seq: 1,
  type: "RunStarted",
  body: { trigger: { type: "mail", payload: { parts: [{ text: JSON.stringify({ projectId: PROJECT_ID, stages: [], code }) }] } } },
});
const PARKED: Event[] = [STARTED, { seq: 2, type: "SignalAwaited", body: { signalName: "project.decision" } }];
const PARKED_TOP = PARKED;

/** A run whose loop applied `decisions` decisions, one iteration each, every one accepted: the run ids and event logs to register. */
function decidedRun(runId: string, decisions: readonly number[], code?: ProjectWorkflowCode): { runIds: string[]; events: Record<string, Event[]> } {
  const runIds = [runId, ...decisions.map((_, index) => `${runId}__rework__${String(index)}`)];
  const events: Record<string, Event[]> = { [runId]: code ? [startedOn(code), PARKED[1]!] : PARKED_TOP };
  const ledger: LedgerRow[] = [];
  decisions.forEach((n, index) => {
    ledger.push({ decisionId: `dec-${String(n)}`, accepted: true, kind: "approve", stage: n });
    events[`${runId}__rework__${String(index)}`] = [STARTED, decision(n), applied(n + 2, [...ledger])];
  });
  return { runIds, events };
}

/**
 * A hub with just enough state to be deployed to: `POST /deployments`
 * makes `dep_new`, a trigger makes `run_new` (started, with the trigger's
 * content on its `RunStarted` the way the real hub records the mail that
 * fired it), and a signal lands on the run it names as a `SignalReceived`
 * event followed by the reducer's `apply` output, the way the real hub's
 * event log would show it once the sidecar took it. Every POST is logged.
 */
function fakeHub(fixture: Fixture) {
  const deployments = (fixture.deployments ?? []).map((entry) => ({ ...entry, tenantId: TENANT_ID }));
  const runsByDeployment: Record<string, string[]> = { ...fixture.runsByDeployment };
  const eventsByRun: Record<string, Event[]> = Object.fromEntries(Object.entries(fixture.eventsByRun ?? {}).map(([id, events]) => [id, [...events]]));
  const ledgerByRun: Record<string, LedgerRow[]> = {};
  const posts: { path: string; body: unknown }[] = [];
  /** Every run event log read, in order: what a memo is meant to spare (#80). */
  const eventReads: string[] = [];
  /** Whether the run named was parked when each signal arrived: what #188 requires of every one. */
  const parkedAtSignal: boolean[] = [];
  /** Reads of a run's log still to come before it shows parked again. */
  const parkPending = new Map<string, number>();
  let pushedTree: Record<string, string> = {};
  let listings = 0;
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const [pathname, query] = path.split("?");
      const tenant = `/api/tenants/${TENANT_ID}`;
      if (method === "POST") posts.push({ path: pathname!, body });
      if (method === "GET" && pathname === tenant) return { id: TENANT_ID, parentId: null } as T;
      if (method === "GET" && pathname === `${tenant}/assets`) {
        return (fixture.assets ?? []).map((asset) => ({ ...asset, tenantId: TENANT_ID, kind: "workflow" })) as T;
      }
      if (method === "GET" && pathname === `${tenant}/workflows/deployments`) {
        listings += 1;
        for (const late of fixture.appearAtListing?.[listings] ?? []) {
          const row = { ...late.deployment, tenantId: TENANT_ID };
          const index = deployments.findIndex((entry) => entry.id === row.id);
          if (index === -1) deployments.push(row);
          else deployments[index] = row;
          if (late.runIds) runsByDeployment[late.deployment.id] = [...late.runIds];
          Object.assign(eventsByRun, late.events ?? {});
        }
        return deployments as T;
      }
      if (method === "POST" && pathname === `${tenant}/workflows/deployments`) {
        const made = { id: "dep_new", tenantId: TENANT_ID, definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-02-01T00:00:00.000Z" };
        deployments.push(made);
        runsByDeployment.dep_new = [];
        return made as T;
      }
      if (method === "GET" && pathname === `${tenant}/catalog/offerings`) {
        return { data: [{ id: "off_1", modelId: "mdl_1", providerId: "mpv_1", priority: 0, disabled: false }], nextCursor: null } as T;
      }
      if (method === "GET" && pathname === `${tenant}/catalog/providers`) {
        return { data: [{ id: "mpv_1", name: "openai", plugin: "openai", disabled: false }], nextCursor: null } as T;
      }
      if (method === "GET" && pathname === `${tenant}/catalog/models`) return { data: [{ id: "mdl_1", canonicalName: "gpt-5.5" }], nextCursor: null } as T;
      if (method === "GET" && pathname === `${tenant}/models`) return [] as T;
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
      if (method === "GET" && events) {
        eventReads.push(events[1]!);
        const pending = parkPending.get(events[1]!);
        if (pending !== undefined) {
          if (pending <= 1) {
            parkPending.delete(events[1]!);
            const log = eventsByRun[events[1]!]!;
            log.push({ ...PARKED[1]!, seq: log.length + 1 });
          } else parkPending.set(events[1]!, pending - 1);
        }
        return { runId: events[1], events: eventsByRun[events[1]!] ?? [] } as T;
      }
      const trigger = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/mail$/.exec(pathname!);
      if (method === "POST" && trigger) {
        runsByDeployment[trigger[1]!] = [...(runsByDeployment[trigger[1]!] ?? []), "run_new"];
        const { content } = body as { content: string };
        // Started, and parked on its first await the way the real run is
        // moments later: a replay waits for that park before it signals.
        eventsByRun.run_new = [{ seq: 1, type: "RunStarted", body: { trigger: { type: "mail", payload: { parts: [{ text: content }] } } } }, PARKED[1]!];
        return { runId: "run_new", address: "run_new@hub", messageId: "msg_1" } as T;
      }
      const signal = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/signals$/.exec(pathname!);
      if (method === "POST" && signal) {
        // The loop applies one signal per iteration: the fake spawns the
        // next iteration of the run named and records the signal there,
        // then the reducer's verdict on it as the iteration's `apply`
        // output, which is what the real hub's event log shows once the
        // sidecar has taken it.
        const input = body as { runId: string; signalName: string; signalId: string; payload: unknown };
        const top = (eventsByRun[input.runId] ??= []);
        parkedAtSignal.push(top.at(-1)?.type === "SignalAwaited");
        if (fixture.parkAfterReads !== undefined) {
          top.push({ seq: top.length + 1, type: "SignalReceived", body: { signalName: input.signalName, signalId: input.signalId, payload: input.payload } });
          if (fixture.endsRunOn === input.signalId) top.push({ seq: top.length + 1, type: "RunCompleted", body: {} });
          else parkPending.set(input.runId, fixture.parkAfterReads);
        }
        const runs = (runsByDeployment[signal[1]!] ??= []);
        const index = runs.filter((id) => id.startsWith(`${input.runId}__`)).length;
        const iteration = `${input.runId}__rework__${String(index)}`;
        runs.push(iteration);
        const verdict = fixture.reducer?.(input.signalId) ?? { accepted: true };
        const decided = (input.payload as { decision?: { kind?: string; stage?: number } }).decision;
        const ledger = (ledgerByRun[input.runId] ??= []);
        ledger.push({ decisionId: input.signalId, accepted: verdict.accepted, ...(verdict.reason ? { reason: verdict.reason } : {}), kind: decided?.kind ?? "?", stage: decided?.stage ?? 0 });
        eventsByRun[iteration] = [
          STARTED,
          { seq: 2, type: "SignalReceived", body: { signalName: input.signalName, signalId: input.signalId, payload: input.payload } },
          applied(3, [...ledger]),
        ];
        return undefined as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
  const gitPush = async ({ tree }: { tree: Readonly<Record<string, string>> }) => {
    pushedTree = { ...tree };
    return "commit_1";
  };
  /** The code the fake's one trigger (`run_new`) was fired with, if a deploy happened. */
  const triggeredCode = (): ProjectWorkflowCode | null => {
    const mail = posts.find((post) => /\/mail$/.test(post.path));
    if (!mail) return null;
    return (JSON.parse((mail.body as { content: string }).content) as { code: ProjectWorkflowCode }).code;
  };
  /** The hub moving on its own: a run's iterations and their logs replaced wholesale. */
  const setRun = (deploymentId: string, runIds: string[], events: Record<string, Event[]>) => {
    runsByDeployment[deploymentId] = [...runIds];
    Object.assign(eventsByRun, events);
  };
  return { transport, gitPush, posts, eventReads, parkedAtSignal, setRun, triggeredCode, signalsSent: () => posts.filter((post) => /\/signals$/.test(post.path)).map((post) => post.body as { runId: string; signalName: string; signalId: string; payload: unknown }) };
}

const ensure = (hub: ReturnType<typeof fakeHub>, replacementWaitMs = 0, placementPollMs?: number, stages: { stage: number; authorizedPrincipalIds: string[] }[] = [], replayPollMs?: number) =>
  ensureProjectWorkflow(hub.transport, { canPlaceSidecars: true }, { files: { "workflow.js": "", "actions.js": "", "loops.js": "" } }, hub.gitPush, PROJECT_ID, stages, {}, {
    replacementWaitMs,
    ...(placementPollMs === undefined ? {} : { placementPollMs }),
    ...(replayPollMs === undefined ? {} : { replayPollMs }),
  });

const withAsset = (fixture: Omit<Fixture, "assets">): Fixture => ({ assets: [{ id: ASSET_ID, name: projectWorkflowAssetName(PROJECT_ID) }], ...fixture });

/** The digest of the code every `ensure` call here renders, as a fresh deploy records it on its trigger. */
const CURRENT_DIGEST = await (async () => {
  const hub = fakeHub(withAsset({}));
  await ensure(hub);
  return hub.triggeredCode()!.digest;
})();
/** A run on the current code, at generation 1: what a project deployed by this code holds. */
const CURRENT: ProjectWorkflowCode = { digest: CURRENT_DIGEST, generation: 1 };
/** A run on code that has since changed: the digest it was pushed with no longer renders. */
const OUTDATED: ProjectWorkflowCode = { digest: "0".repeat(64), generation: 1 };

describe("findProjectWorkflow", () => {
  test("no asset yet -> null", async () => {
    expect(await findProjectWorkflow(fakeHub({}).transport, PROJECT_ID)).toBeNull();
  });

  test("asset exists but no deployment matches it -> null", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_other", definitionAssetId: "asset_other", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }] }));
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toBeNull();
  });

  test("deployment exists but no top-level run has been triggered -> null", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_1: [] } }));
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toBeNull();
  });

  test("several top-level runs already exist -> picks the oldest, the same winner every caller converges on", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
        // Iteration children (contain `__`) are excluded; only bare ids count.
        runsByDeployment: { dep_1: ["run_b", "run_a__rework__1", "run_c", "run_a"] },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_1", runId: "run_a", tenantId: TENANT_ID });
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
        runsByDeployment: { dep_new_live: ["run_1"], dep_old_failed: decidedRun("run_0", [1, 2]).runIds },
        eventsByRun: { ...decidedRun("run_0", [1, 2]).events, run_1: PARKED },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_old_failed", runId: "run_0", tenantId: TENANT_ID });
  });

  // #77: every replacement replays the whole history onto itself, so the
  // newest dead run that took decisions holds everything the older ones
  // did and more. Reading the oldest showed a stage the project had already
  // left, and the page offered that stage's approval again.
  test("several dead runs, none caught up by a live one -> reads the one holding the most decisions, not the oldest", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_oldest_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_later_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-03T00:00:00.000Z" },
        ],
        runsByDeployment: {
          dep_oldest_failed: decidedRun("run_0", [1, 2]).runIds,
          dep_later_failed: decidedRun("run_1", [1, 2, 3]).runIds,
          dep_new_live: decidedRun("run_2", [1]).runIds,
        },
        eventsByRun: { ...decidedRun("run_0", [1, 2]).events, ...decidedRun("run_1", [1, 2, 3]).events, ...decidedRun("run_2", [1]).events },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_later_failed", runId: "run_1", tenantId: TENANT_ID });
  });

  test("a live run that holds every decision the dead one took is the project's run", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "active", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_new_live: decidedRun("run_1", [1, 2]).runIds, dep_old_failed: decidedRun("run_0", [1, 2]).runIds },
        eventsByRun: { ...decidedRun("run_0", [1, 2]).events, ...decidedRun("run_1", [1, 2]).events },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_new_live", runId: "run_1", tenantId: TENANT_ID });
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
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_new_live", runId: "run_1", tenantId: TENANT_ID });
  });

  // #161: a dead run with no decisions still holds the project's state (its
  // init output), so with nothing live it is what a reader folds; a card
  // after a host restart shows stage 1, not "unavailable". The newest such
  // run wins.
  test("only failed deployments whose runs never took a decision -> the newest one is read", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_newer_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_old_failed: ["run_0"], dep_newer_failed: ["run_1"] },
        eventsByRun: { run_0: PARKED, run_1: PARKED },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_newer_failed", runId: "run_1", tenantId: TENANT_ID });
  });

  test("a dead run with decisions is read over a newer dead run without any", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_decided", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_empty", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_decided: decidedRun("run_0", [1]).runIds, dep_empty: ["run_1"] },
        eventsByRun: { ...decidedRun("run_0", [1]).events, run_1: PARKED },
      }),
    );
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_decided", runId: "run_0", tenantId: TENANT_ID });
  });

  // #51: the hub cannot end a deployment, so a run replaced by a newer
  // generation stays live beside its replacement. It is the project's run
  // only until the replacement has caught up with its decisions.
  test("two live runs: the older generation is read until the newer one holds its decisions, then the newer one", async () => {
    const notCaughtUp = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_upgraded", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_old: decidedRun("run_0", [1, 2], OUTDATED).runIds, dep_upgraded: decidedRun("run_1", [1], { ...CURRENT, generation: 2 }).runIds },
        eventsByRun: { ...decidedRun("run_0", [1, 2], OUTDATED).events, ...decidedRun("run_1", [1], { ...CURRENT, generation: 2 }).events },
      }),
    );
    expect(await findProjectWorkflow(notCaughtUp.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_old", runId: "run_0", tenantId: TENANT_ID });

    const caughtUp = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_upgraded", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_old: decidedRun("run_0", [1, 2], OUTDATED).runIds, dep_upgraded: decidedRun("run_1", [1, 2], { ...CURRENT, generation: 2 }).runIds },
        eventsByRun: { ...decidedRun("run_0", [1, 2], OUTDATED).events, ...decidedRun("run_1", [1, 2], { ...CURRENT, generation: 2 }).events },
      }),
    );
    expect(await findProjectWorkflow(caughtUp.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_upgraded", runId: "run_1", tenantId: TENANT_ID });
  });
});

// #80: a page polls `findProjectWorkflow` every few seconds, and each read
// used to fetch every iteration's event log of every deployment the project
// ever had. With a memo, an ended deployment's run is read once, and a live
// run's finished iterations are read once; only its newest iteration, the
// one that can still take a signal, is read again.
describe("findProjectWorkflow with a decision memo", () => {
  const fixture = () =>
    withAsset({
      deployments: [
        { id: "dep_dead", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "dep_live", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
      runsByDeployment: { dep_dead: decidedRun("run_0", [1, 2]).runIds, dep_live: decidedRun("run_1", [1, 2], CURRENT).runIds },
      eventsByRun: { ...decidedRun("run_0", [1, 2]).events, ...decidedRun("run_1", [1, 2], CURRENT).events },
    });

  test("a second read with the same memo re-reads only the live run's newest iteration", async () => {
    const hub = fakeHub(fixture());
    const memo = createDecisionMemo();
    const first = await findProjectWorkflow(hub.transport, PROJECT_ID, memo);
    expect(first).toEqual({ deploymentId: "dep_live", runId: "run_1", tenantId: TENANT_ID });
    expect(hub.eventReads.length).toBeGreaterThan(2);

    hub.eventReads.length = 0;
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID, memo)).toEqual(first);
    // The live run's own RunStarted (its code) and its newest iteration.
    expect(hub.eventReads).toEqual(["run_1", "run_1__rework__1"]);
  });

  test("without a memo every read fetches everything, as before", async () => {
    const hub = fakeHub(fixture());
    await findProjectWorkflow(hub.transport, PROJECT_ID);
    const firstReads = [...hub.eventReads];
    hub.eventReads.length = 0;
    await findProjectWorkflow(hub.transport, PROJECT_ID);
    expect(hub.eventReads).toEqual(firstReads);
  });

  test("a signal the live run takes after the first read is seen on the next", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_dead", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_live", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_dead: decidedRun("run_0", [1, 2]).runIds, dep_live: decidedRun("run_1", [1], CURRENT).runIds },
        eventsByRun: { ...decidedRun("run_0", [1, 2]).events, ...decidedRun("run_1", [1], CURRENT).events },
      }),
    );
    const memo = createDecisionMemo();
    // The live run holds only decision 1 of the dead run's two: the dead run is still the project's.
    expect((await findProjectWorkflow(hub.transport, PROJECT_ID, memo))?.deploymentId).toBe("dep_dead");
    // Then the live run applies decision 2 in a new iteration.
    const caughtUp = decidedRun("run_1", [1, 2], CURRENT);
    hub.setRun("dep_live", caughtUp.runIds, caughtUp.events);
    expect((await findProjectWorkflow(hub.transport, PROJECT_ID, memo))?.deploymentId).toBe("dep_live");
  });
});

describe("ensureProjectWorkflow", () => {
  test("a live run on the current code that has caught up is returned as is: nothing pushed, deployed, triggered or signalled", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_1: decidedRun("run_1", [1, 2], CURRENT).runIds }, eventsByRun: decidedRun("run_1", [1, 2], CURRENT).events }));
    expect(await ensure(hub)).toEqual({ deploymentId: "dep_1", runId: "run_1", tenantId: TENANT_ID });
    expect(hub.posts).toEqual([]);
  });

  test("a fresh deploy triggers its run with the code it runs, at generation 1", async () => {
    const hub = fakeHub(withAsset({}));
    expect(await ensure(hub)).toEqual({ deploymentId: "dep_new", runId: "run_new", tenantId: TENANT_ID });
    expect(hub.triggeredCode()).toEqual({ digest: CURRENT_DIGEST, generation: 1 });
    expect(hub.signalsSent()).toEqual([]);
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
        runsByDeployment: { dep_1: decidedRun("run_1", [1, 2]).runIds },
        eventsByRun: decidedRun("run_1", [1, 2]).events,
      }),
    );
    expect(await ensure(hub)).toEqual({
      deploymentId: "dep_new",
      runId: "run_new",
      tenantId: TENANT_ID,
      replay: { from: { deploymentId: "dep_1", runId: "run_1", tenantId: TENANT_ID }, replayed: 2, refused: [] },
    });
    expect(hub.signalsSent()).toEqual([
      { runId: "run_new", signalName: "project.decision", signalId: "dec-1", payload: decisionPayload(1) },
      { runId: "run_new", signalName: "project.decision", signalId: "dec-2", payload: decisionPayload(2) },
    ]);
    // And from then on, every reader converges on the revived run.
    expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_new", runId: "run_new", tenantId: TENANT_ID });
  });

  // The hub appends a delivered signal to the run's log itself. While the
  // run's child is still writing the rest of its turn -- child completed,
  // step completed, next step started, next await -- the log ends in that
  // SignalReceived, and a signal sent then takes the sequence number the
  // child is about to use and kills the run. So a decision is sent only once
  // the run is parked, and counts as landed only once the run has parked
  // again after it (#188).
  test("replays each decision only once the run has parked again after the one before", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_1: decidedRun("run_1", [1, 2, 3]).runIds },
        eventsByRun: decidedRun("run_1", [1, 2, 3]).events,
        parkAfterReads: 3,
      }),
    );
    expect(await ensure(hub, 0, undefined, [], 1)).toMatchObject({ deploymentId: "dep_new", runId: "run_new", replay: { replayed: 3, refused: [] } });
    expect(hub.signalsSent().map((sent) => sent.signalId)).toEqual(["dec-1", "dec-2", "dec-3"]);
    expect(hub.parkedAtSignal).toEqual([true, true, true]);
  });

  test("a replayed decision on which the run completes counts as landed", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_1: decidedRun("run_1", [1, 2]).runIds },
        eventsByRun: decidedRun("run_1", [1, 2]).events,
        parkAfterReads: 1,
        endsRunOn: "dec-2",
      }),
    );
    expect(await ensure(hub, 0, undefined, [], 1)).toMatchObject({ deploymentId: "dep_new", runId: "run_new", replay: { replayed: 2 } });
    expect(hub.parkedAtSignal).toEqual([true, true]);
  });

  test("a live run that has not caught up is brought up to the dead run's decisions, not replaced", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [
          { id: "dep_old_failed", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "dep_new_live", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        runsByDeployment: { dep_old_failed: decidedRun("run_0", [1, 2]).runIds, dep_new_live: decidedRun("run_1", [1]).runIds },
        eventsByRun: { ...decidedRun("run_0", [1, 2]).events, ...decidedRun("run_1", [1]).events },
      }),
    );
    expect(await ensure(hub)).toMatchObject({ deploymentId: "dep_new_live", runId: "run_1", replay: { from: { deploymentId: "dep_old_failed", runId: "run_0", tenantId: TENANT_ID }, replayed: 2, refused: [] } });
    expect(hub.signalsSent().map((sent) => sent.signalId)).toEqual(["dec-2"]);
  });

  // After a restart the hub replaces a dead deployment on its own, as a new
  // deployment carrying the run's restored history, within seconds. A
  // project that deployed its own in that window would have two; waiting
  // for the replacement first is what keeps it to one.
  test("waits for the hub's replacement of a dead deployment rather than deploying its own", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_dead", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_dead: decidedRun("run_0", [1, 2]).runIds },
        eventsByRun: decidedRun("run_0", [1, 2]).events,
        appearAtListing: {
          2: [
            {
              deployment: { id: "dep_replacement", definitionAssetId: ASSET_ID, status: "running", createdAt: "2026-01-03T00:00:00.000Z" },
              runIds: decidedRun("run_r", [1, 2], CURRENT).runIds,
              events: decidedRun("run_r", [1, 2], CURRENT).events,
            },
          ],
        },
      }),
    );
    expect(await ensure(hub, 10_000)).toEqual({ deploymentId: "dep_replacement", runId: "run_r", tenantId: TENANT_ID });
    expect(hub.posts).toEqual([]);
  });

  test("keeps waiting for the hub's replacement past the wait bound while the hub is still placing other deployments", async () => {
    // After a restart the hub restores sidecars one at a time: another
    // deployment moves on the third listing, and this project's replacement
    // only appears on the fifth. A bound counted from the call's start
    // (listing 2) would have run out by the fourth listing; one counted
    // from the hub's last visible move has not (#79).
    const other = (status: string) => ({ deployment: { id: "dep_other", definitionAssetId: "asset_other", status, createdAt: "2026-01-02T00:00:00.000Z" } });
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_dead", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_dead: decidedRun("run_0", [1, 2]).runIds },
        eventsByRun: decidedRun("run_0", [1, 2]).events,
        appearAtListing: {
          2: [other("recovering")],
          3: [other("deployed")],
          5: [
            {
              deployment: { id: "dep_replacement", definitionAssetId: ASSET_ID, status: "running", createdAt: "2026-01-03T00:00:00.000Z" },
              runIds: decidedRun("run_r", [1, 2], CURRENT).runIds,
              events: decidedRun("run_r", [1, 2], CURRENT).events,
            },
          ],
        },
      }),
    );
    expect(await ensure(hub, 100, 60)).toEqual({ deploymentId: "dep_replacement", runId: "run_r", tenantId: TENANT_ID });
    expect(hub.posts).toEqual([]);
  });

  test("deploys its own replacement once the hub has sat still for the wait bound", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_dead", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_dead: decidedRun("run_0", [1, 2]).runIds },
        eventsByRun: decidedRun("run_0", [1, 2]).events,
      }),
    );
    expect(await ensure(hub, 40, 10)).toMatchObject({ deploymentId: "dep_new", runId: "run_new", tenantId: TENANT_ID });
    expect(hub.posts.some((post) => post.path.endsWith("/workflows/deployments"))).toBe(true);
  });

  test("deploys afresh when the only deployment has ended and its run never took a decision", async () => {
    const hub = fakeHub(withAsset({ deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }], runsByDeployment: { dep_1: ["run_1"] }, eventsByRun: { run_1: PARKED } }));
    // Nothing to replay, so no replacement wait and no signals; the dead run
    // is named as what the fresh one stands in for (#161).
    expect(await ensure(hub)).toEqual({
      deploymentId: "dep_new",
      runId: "run_new",
      tenantId: TENANT_ID,
      replay: { from: { deploymentId: "dep_1", runId: "run_1", tenantId: TENANT_ID }, replayed: 0, refused: [] },
    });
    expect(hub.signalsSent()).toEqual([]);
    expect(hub.posts.some((post) => post.path.endsWith("/workflows/deployments"))).toBe(true);
  });

  // #51: a project's workflow used to be deployed once and reused whatever
  // code it ran, so a reducer fix reached only projects created after it.
  // A live run on other code than the current render is replaced the way
  // a dead one is revived, with its decisions replayed onto the new code.
  // #165: the authorities a run was triggered with are part of what it runs
  // on. A run told only the workspace principal refuses every decision the
  // owner signals from the project tenant, and only a fresh run can be told.
  test("a live run on the current code but other stage authorities is replaced, its decisions replayed", async () => {
    const hub = fakeHub(
      withAsset({
        deployments: [{ id: "dep_1", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" }],
        runsByDeployment: { dep_1: decidedRun("run_1", [1], CURRENT).runIds },
        eventsByRun: decidedRun("run_1", [1], CURRENT).events,
      }),
    );
    const stages = [{ stage: 1, authorizedPrincipalIds: ["prn_project_owner", "prn_workspace_owner"] }];
    const ensured = await ensure(hub, 0, undefined, stages);
    expect(ensured).toMatchObject({ deploymentId: "dep_new", runId: "run_new", replay: { from: { deploymentId: "dep_1", runId: "run_1" }, replayed: 1 } });
    expect(hub.triggeredCode()).toMatchObject({ generation: 2 });
    expect(hub.triggeredCode()!.digest).not.toBe(CURRENT_DIGEST);
    expect(hub.signalsSent().map((sent) => sent.signalId)).toEqual(["dec-1"]);
    // And the same authorities again are the same code: nothing is replaced twice.
    const again = fakeHub(
      withAsset({
        deployments: [{ id: "dep_2", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-02T00:00:00.000Z" }],
        runsByDeployment: { dep_2: decidedRun("run_2", [1], { digest: hub.triggeredCode()!.digest, generation: 2 }).runIds },
        eventsByRun: decidedRun("run_2", [1], { digest: hub.triggeredCode()!.digest, generation: 2 }).events,
      }),
    );
    expect(await ensure(again, 0, undefined, stages)).toEqual({ deploymentId: "dep_2", runId: "run_2", tenantId: TENANT_ID });
    expect(again.posts).toEqual([]);
  });

  describe("a live run on other code than the current render (#51)", () => {
    const outdatedLive = (reducer?: Fixture["reducer"]) =>
      fakeHub(
        withAsset({
          deployments: [{ id: "dep_old", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" }],
          runsByDeployment: { dep_old: decidedRun("run_old", [1, 2], OUTDATED).runIds },
          eventsByRun: decidedRun("run_old", [1, 2], OUTDATED).events,
          ...(reducer ? { reducer } : {}),
        }),
      );

    test("is replaced: the new code is deployed at the next generation and every decision is replayed in order", async () => {
      const hub = outdatedLive();
      expect(await ensure(hub)).toEqual({
        deploymentId: "dep_new",
        runId: "run_new",
        tenantId: TENANT_ID,
        replay: { from: { deploymentId: "dep_old", runId: "run_old", tenantId: TENANT_ID }, replayed: 2, refused: [] },
      });
      expect(hub.triggeredCode()).toEqual({ digest: CURRENT_DIGEST, generation: 2 });
      expect(hub.signalsSent()).toEqual([
        { runId: "run_new", signalName: "project.decision", signalId: "dec-1", payload: decisionPayload(1) },
        { runId: "run_new", signalName: "project.decision", signalId: "dec-2", payload: decisionPayload(2) },
      ]);
      // The old deployment is still live (the hub cannot end it), and every reader now converges on the new run.
      expect(await findProjectWorkflow(hub.transport, PROJECT_ID)).toEqual({ deploymentId: "dep_new", runId: "run_new", tenantId: TENANT_ID });
      // And the new run is current: the next call reuses it without deploying again.
      const before = hub.posts.length;
      expect(await ensure(hub)).toEqual({ deploymentId: "dep_new", runId: "run_new", tenantId: TENANT_ID });
      expect(hub.posts.length).toBe(before);
    });

    test("a run from before code was recorded on the trigger counts as other code, and is replaced the same way", async () => {
      const hub = fakeHub(
        withAsset({
          deployments: [{ id: "dep_old", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" }],
          runsByDeployment: { dep_old: decidedRun("run_old", [1]).runIds },
          eventsByRun: decidedRun("run_old", [1]).events,
        }),
      );
      expect(await ensure(hub)).toMatchObject({ deploymentId: "dep_new", runId: "run_new", replay: { replayed: 1, refused: [] } });
      expect(hub.triggeredCode()).toEqual({ digest: CURRENT_DIGEST, generation: 1 });
    });

    test("a replayed decision the new rules refuse is recorded by the reducer and reported, never dropped", async () => {
      const hub = outdatedLive((decisionId) => (decisionId === "dec-2" ? { accepted: false, reason: "quorum_not_met" } : { accepted: true }));
      const ensured = await ensure(hub);
      expect(ensured.replay).toEqual({
        from: { deploymentId: "dep_old", runId: "run_old", tenantId: TENANT_ID },
        replayed: 2,
        refused: [{ decisionId: "dec-2", kind: "approve", stage: 2, reason: "quorum_not_met" }],
      });
      // Both decisions were delivered: a refusal is the reducer's ledger row, not a skipped signal.
      expect(hub.signalsSent().map((sent) => sent.signalId)).toEqual(["dec-1", "dec-2"]);
    });

    test("a decision the old run had already refused is not reported again when the new run refuses it too", async () => {
      const hub = fakeHub(
        withAsset({
          deployments: [{ id: "dep_old", definitionAssetId: ASSET_ID, status: "deployed", createdAt: "2026-01-01T00:00:00.000Z" }],
          runsByDeployment: { dep_old: ["run_old", "run_old__rework__0"] },
          eventsByRun: {
            run_old: [startedOn(OUTDATED), PARKED[1]!],
            run_old__rework__0: [STARTED, decision(1), applied(3, [{ decisionId: "dec-1", accepted: false, reason: "wrong_stage", kind: "approve", stage: 1 }])],
          },
          reducer: () => ({ accepted: false, reason: "wrong_stage" }),
        }),
      );
      expect((await ensure(hub)).replay).toEqual({ from: { deploymentId: "dep_old", runId: "run_old", tenantId: TENANT_ID }, replayed: 1, refused: [] });
    });
  });
});

describe("namerPin", () => {
  const LEAD = { provider: "anthropic", model: "claude-opus-5" };
  const offering = (offeringId: string, plugin: string, price?: [string, string]) => ({
    offeringId,
    plugin,
    capabilities: ["plain-text"],
    pricing: price ? [{ currency: "USD", inputTokenPrice: price[0], outputTokenPrice: price[1] }] : [],
  });
  const ALL = new Set(["off_opus", "off_haiku", "off_gpt"]);

  test("picks the cheapest priced model of the leading provider", () => {
    const models = [
      { canonicalName: "claude-opus-5", offerings: [offering("off_opus", "anthropic", ["15", "75"])] },
      { canonicalName: "claude-haiku-5", offerings: [offering("off_haiku", "anthropic", ["1", "5"])] },
      { canonicalName: "gpt-mini", offerings: [offering("off_gpt", "openai", ["0.1", "0.4"])] },
    ];
    expect(namerPin(LEAD, ALL, models)).toEqual({ provider: "anthropic", model: "claude-haiku-5" });
  });

  test("never assumes an unpriced or undeployable model is cheap", () => {
    const models = [
      { canonicalName: "claude-opus-5", offerings: [offering("off_opus", "anthropic")] },
      { canonicalName: "claude-haiku-5", offerings: [offering("off_haiku", "anthropic")] },
    ];
    expect(namerPin(LEAD, ALL, models)).toEqual(LEAD);
    const priced = [{ canonicalName: "claude-haiku-5", offerings: [offering("off_haiku", "anthropic", ["1", "5"])] }];
    expect(namerPin(LEAD, new Set(["off_opus"]), priced)).toEqual(LEAD);
  });
});

describe("ensureProjectWorkflow's name step", () => {
  test("pins the namer beside workflow.js and hands the opening statement to the trigger", async () => {
    const hub = fakeHub(withAsset({}));
    let pushed: Readonly<Record<string, string>> = {};
    const gitPush = async (args: { tree: Readonly<Record<string, string>> }) => {
      pushed = args.tree;
      return hub.gitPush(args);
    };
    await ensureProjectWorkflow(
      hub.transport,
      { canPlaceSidecars: true },
      { files: { "workflow.js": "", "actions.js": "", "loops.js": "" } },
      gitPush as typeof hub.gitPush,
      PROJECT_ID,
      [],
      {},
      { problemStatement: "Reconcile invoices" },
    );
    expect(pushed["packages/project/namer-source.js"]).toBe(`export const NAMER_SOURCE = {"provider":"openai","model":"gpt-5.5"};\n`);
    const mail = hub.posts.find((post) => /\/mail$/.test(post.path));
    expect(JSON.parse((mail!.body as { content: string }).content).problemStatement).toBe("Reconcile invoices");
  });
});
