import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { notifyDecisionOpen, type NotifiableDecision } from "./decision-notify.ts";

const WS = "tnt_ws";
const PROJECT = "tnt_project";

function decision(overrides: Partial<NotifiableDecision> = {}): NotifiableDecision {
  return {
    id: "dec_1",
    projectId: PROJECT,
    runId: "run_1",
    stage: 1,
    title: "Accept the problem brief",
    consequence: "A human decision is required to continue.",
    blockers: null,
    requiredAuthority: "problem_owner",
    ...overrides,
  };
}

type Route = { readonly method: string; readonly path: string; readonly respond: (body?: unknown) => unknown };

function fakeTransport(routes: Route[], calls: { method: string; path: string; body?: unknown }[]): Transport {
  return {
    fetch: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const route = routes.find((r) => r.method === method && path.startsWith(r.path));
      if (!route) throw new Error(`unhandled fetch: ${method} ${path}`);
      return route.respond(body) as T;
    },
    subscribe: () => () => {},
  };
}

const sentEmpty = { method: "GET", path: `/api/tenants/${WS}/mailbox/me/inbox?folder=Sent`, respond: () => ({ messages: [] }) };
const grantsFor = (address: string) => [
  { method: "GET", path: `/api/tenants/${PROJECT}/grants`, respond: () => ({ data: [{ id: "g1", roleId: null, principalId: "p1", resource: "approval:*", action: "resolve", effect: "allow", origin: "system" }], nextCursor: null }) },
  { method: "GET", path: `/api/tenants/${PROJECT}/principals`, respond: () => ({ data: [{ id: "p1", refId: address.split("@")[0], roles: [] }], nextCursor: null }) },
  { method: "GET", path: `/api/tenants/${PROJECT}`, respond: () => ({ domain: address.split("@")[1] }) },
];

describe("notifyDecisionOpen", () => {
  test("reports notifiedAt from an already-sent marker without sending again", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const transport = fakeTransport(
      [
        {
          method: "GET",
          path: `/api/tenants/${WS}/mailbox/me/inbox?folder=Sent`,
          respond: () => ({ messages: [{ envelope: { subject: "[decision:dec_1] Accept the problem brief", date: "2026-01-01T00:00:00.000Z" } }] }),
        },
      ],
      calls,
    );
    const outcome = await notifyDecisionOpen(WS, decision(), transport);
    expect(outcome).toEqual({ notifiedAt: "2026-01-01T00:00:00.000Z" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("sends to every grant holder and reports a fresh notifiedAt", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const sendRoute: Route = { method: "POST", path: `/api/tenants/${WS}/mailbox/me/inbox/send`, respond: () => undefined };
    const transport = fakeTransport([sentEmpty, ...grantsFor("p1@corbits.test"), sendRoute], calls);
    const outcome = await notifyDecisionOpen(WS, decision(), transport);
    expect(outcome.notifiedAt).toBeDefined();
    expect(outcome.notifyError).toBeUndefined();
    const sendCall = calls.find((c) => c.method === "POST");
    expect(sendCall).toBeDefined();
    expect((sendCall!.body as { to: string[] }).to).toEqual(["p1@corbits.test"]);
    expect((sendCall!.body as { subject: string }).subject).toContain("[decision:dec_1]");
  });

  test("reports no outcome when there is no one to notify", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const transport = fakeTransport(
      [
        sentEmpty,
        { method: "GET", path: `/api/tenants/${PROJECT}/grants`, respond: () => ({ data: [], nextCursor: null }) },
        { method: "GET", path: `/api/tenants/${PROJECT}/principals`, respond: () => ({ data: [], nextCursor: null }) },
        { method: "GET", path: `/api/tenants/${PROJECT}`, respond: () => ({ domain: "corbits.test" }) },
      ],
      calls,
    );
    const outcome = await notifyDecisionOpen(WS, decision(), transport);
    expect(outcome).toEqual({});
  });

  test("reports notifyError instead of throwing when the read fails", async () => {
    const transport: Transport = {
      fetch: async () => {
        throw new Error("hub is down");
      },
      subscribe: () => () => {},
    };
    const outcome = await notifyDecisionOpen(WS, decision(), transport);
    expect(outcome.notifyError).toBe("hub is down");
    expect(outcome.notifiedAt).toBeUndefined();
  });
});
