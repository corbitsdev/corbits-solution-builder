import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { listProjectSummaries } from "./project-list.ts";

const AT = "2026-01-01T00:00:00.000Z";

type Deployment = { id: string; tenantId: string; definitionAssetId: string; status: string; createdAt: string };
type RunEvent = { seq: number; type: string; body: Record<string, unknown> };

/**
 * Serves exactly the calls `listProjectSummaries` makes: workspace
 * resolution, the workspace's child tenants (project records), each
 * project's deployments, and each deployment's run events -- the same
 * routes `run-fold.test.ts` fakes for the fold itself.
 */
function fakeTransport(args: {
  projects: { id: string; name: string; config: Record<string, unknown>; createdAt: string }[];
  deployments: Record<string, Deployment[]>;
  runs: Record<string, Record<string, RunEvent[]>>;
}): Transport {
  return {
    async fetch<T>(_method: string, path: string): Promise<T> {
      const [pathname, query] = path.split("?");
      const params = new URLSearchParams(query);
      if (pathname === "/api/me") return { id: "usr_1" } as T;
      if (pathname === "/api/me/principals") {
        return {
          data: [
            { principalId: "pr_1", tenantId: "tnt_ws", tenantSlug: "solutions-builder", kind: "user", status: "active" },
          ],
          nextCursor: null,
        } as T;
      }
      if (pathname === "/api/tenants" && params.get("parentId") === "tnt_ws") {
        return args.projects as T;
      }
      const deployMatch = /^\/api\/tenants\/([^/]+)\/workflows\/deployments$/.exec(pathname ?? "");
      if (deployMatch) return (args.deployments[deployMatch[1]!] ?? []) as T;
      const runsMatch = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/runs$/.exec(pathname ?? "");
      if (runsMatch) return { runIds: Object.keys(args.runs[runsMatch[1]!] ?? {}) } as T;
      const eventsMatch = /^\/api\/tenants\/[^/]+\/workflows\/([^/]+)\/runs\/([^/]+)\/events$/.exec(pathname ?? "");
      if (eventsMatch) {
        const [, deploymentId, runId] = eventsMatch;
        return { runId, events: args.runs[deploymentId!]?.[runId!] ?? [] } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    subscribe: () => () => undefined,
  };
}

function projectRow(id: string, title: string) {
  return {
    id,
    name: title,
    config: {
      solutionsBuilder: {
        policy: { costTolerancePercent: 10, costToleranceAbsolute: 50, audiences: [], audienceQuorum: 1, allowExternalProviders: false },
        policyVersion: 1,
        revision: 1,
        archivedAt: null,
        deletedAt: null,
      },
    },
    createdAt: AT,
  };
}

function deployment(id: string, tenantId: string, status = "allocated"): Deployment {
  return { id, tenantId, definitionAssetId: "ast_1", status, createdAt: AT };
}

describe("listProjectSummaries", () => {
  test("no workspace means no projects", async () => {
    const transport: Transport = {
      async fetch<T>(_method: string, path: string): Promise<T> {
        if (path === "/api/me") return null as T;
        throw new Error(`unexpected ${path}`);
      },
      subscribe: () => () => undefined,
    };
    expect(await listProjectSummaries(transport)).toEqual([]);
  });

  test("a project with no deployment yet is idle", async () => {
    const transport = fakeTransport({
      projects: [projectRow("p1", "First")],
      deployments: { p1: [] },
      runs: {},
    });
    const [summary] = await listProjectSummaries(transport);
    expect(summary).toMatchObject({ id: "p1", title: "First", turn: "idle", stage: null, needsDecision: false });
  });

  test("a parked gate reads as waiting on approval", async () => {
    const transport = fakeTransport({
      projects: [projectRow("p1", "First")],
      deployments: { p1: [deployment("dep_1", "p1")] },
      runs: {
        dep_1: {
          dep_1: [
            { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
            { seq: 2, type: "StepStarted", body: { at: AT, stepId: "gate-3", attempt: 1, input: { ref: "inline:null" } } },
            { seq: 3, type: "SignalAwaited", body: { at: AT, stepId: "gate-3", signalName: "solutions-builder.stage.3.approve" } },
          ],
        },
      },
    });
    const [summary] = await listProjectSummaries(transport);
    expect(summary).toMatchObject({ id: "p1", stage: 3, turn: "approve", needsDecision: true, runId: "dep_1" });
  });

  test("a parked round reads as a question waiting on the person", async () => {
    const transport = fakeTransport({
      projects: [projectRow("p1", "First")],
      deployments: { p1: [deployment("dep_1", "p1")] },
      runs: {
        dep_1: {
          dep_1: [
            { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
            { seq: 2, type: "StepStarted", body: { at: AT, stepId: "revise-2", attempt: 1, input: { ref: "inline:null" } } },
            { seq: 3, type: "SignalAwaited", body: { at: AT, stepId: "revise-2", signalName: "solutions-builder.stage.2.round" } },
          ],
        },
      },
    });
    const [summary] = await listProjectSummaries(transport);
    expect(summary).toMatchObject({ stage: 2, turn: "question", needsDecision: true });
  });

  test("an in-flight step reads as writing", async () => {
    const transport = fakeTransport({
      projects: [projectRow("p1", "First")],
      deployments: { p1: [deployment("dep_1", "p1")] },
      runs: {
        dep_1: {
          dep_1: [
            { seq: 1, type: "RunStarted", body: { at: AT, definitionHash: "x" } },
            { seq: 2, type: "StepStarted", body: { at: AT, stepId: "revise-1", attempt: 1, input: { ref: "inline:null" } } },
          ],
        },
      },
    });
    const [summary] = await listProjectSummaries(transport);
    expect(summary).toMatchObject({ stage: 1, turn: "writing", needsDecision: false });
  });

  test("picks the live deployment over an ended one", async () => {
    const transport = fakeTransport({
      projects: [projectRow("p1", "First")],
      deployments: { p1: [deployment("dep_old", "p1", "released"), deployment("dep_new", "p1", "allocated")] },
      runs: { dep_new: { dep_new: [{ seq: 1, type: "RunStarted", body: { at: AT } }] } },
    });
    const [summary] = await listProjectSummaries(transport);
    expect(summary?.runId).toBe("dep_new");
  });
});
