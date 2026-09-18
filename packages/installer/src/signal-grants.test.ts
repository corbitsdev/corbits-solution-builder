import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import { approveSignal, evidenceSignal, freezeSignal } from "@solutions-builder/app/workflows/stage-loop";
import type { HubGrant, HubRole } from "./hub.js";
import { installProjectAuthority } from "./project-tenant.js";
import {
  WORKFLOW_RUN_RESOURCE,
  authorityHoldsCommand,
  signalGrantAction,
  signalGrantsFor,
  signalNamesFor,
} from "./signal-grants.js";

const HUMANS = AUTHORITIES.filter((name): name is Exclude<Authority, "system"> => name !== "system");

function actionsFor(authority: Authority): Set<string> {
  return new Set(signalGrantsFor(authority).map((grant) => grant.action));
}

describe("signalGrantsFor", () => {
  test("every grant is workflow-run:* / signal:<name>", () => {
    for (const authority of HUMANS) {
      for (const grant of signalGrantsFor(authority)) {
        expect(grant.resource).toBe(WORKFLOW_RUN_RESOURCE);
        expect(grant.action.startsWith("signal:")).toBe(true);
        expect(grant.action).toBe(signalGrantAction(grant.action.slice("signal:".length)));
      }
    }
  });

  test("system is never granted a signal", () => {
    expect(signalNamesFor("system")).toEqual([]);
    expect(signalGrantsFor("system")).toEqual([]);
  });

  test("a draft round never mints a signal: the chat section drives rounds by mail", () => {
    expect(authorityHoldsCommand("project_owner", "stage.draft")).toBe(true);
    const owner = actionsFor("project_owner");
    for (let stage = 1; stage <= 9; stage++) {
      expect(owner.has(signalGrantAction(`solutions-builder.stage.${stage}.round`))).toBe(false);
    }
  });

  test("a role without the authority does not get that command's signal", () => {
    const owner = actionsFor("project_owner");
    const budget = actionsFor("budget_approver");
    const builder = actionsFor("builder_operator");
    const audience = actionsFor("audience_member");
    const delivery = actionsFor("delivery_recipient");

    expect(authorityHoldsCommand("budget_approver", "cost.approve")).toBe(true);
    expect(authorityHoldsCommand("delivery_recipient", "cost.approve")).toBe(false);
    expect(authorityHoldsCommand("audience_member", "cost.approve")).toBe(false);
    expect(budget.has(signalGrantAction(approveSignal(7)))).toBe(true);
    expect(delivery.has(signalGrantAction(approveSignal(7)))).toBe(false);

    expect(authorityHoldsCommand("builder_operator", "audience.decide")).toBe(false);
    expect(authorityHoldsCommand("audience_member", "audience.decide")).toBe(true);
    expect(builder.has(signalGrantAction(approveSignal(5)))).toBe(false);
    expect(audience.has(signalGrantAction(approveSignal(5)))).toBe(true);

    expect(authorityHoldsCommand("project_owner", "build.accept_evidence")).toBe(true);
    expect(authorityHoldsCommand("builder_operator", "build.fail")).toBe(true);
    expect(owner.has(signalGrantAction(evidenceSignal(8)))).toBe(true);
    expect(builder.has(signalGrantAction(evidenceSignal(8)))).toBe(true);
    expect(budget.has(signalGrantAction(evidenceSignal(8)))).toBe(false);

    expect(authorityHoldsCommand("builder_operator", "build.freeze")).toBe(true);
    expect(authorityHoldsCommand("project_owner", "build.freeze")).toBe(true);
    expect(builder.has(signalGrantAction(freezeSignal()))).toBe(true);
    expect(owner.has(signalGrantAction(freezeSignal()))).toBe(true);
    expect(budget.has(signalGrantAction(freezeSignal()))).toBe(false);
  });
});

function fakeProjectTransport(projectId: string): Transport & { grants: HubGrant[]; roles: HubRole[] } {
  const roles: HubRole[] = [];
  const grants: HubGrant[] = [];
  let roleSeq = 0;
  let grantSeq = 0;
  return {
    roles,
    grants,
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const pathname = path.split("?")[0] ?? path;
      if (method === "GET" && pathname === "/api/me/principals") {
        return {
          data: [
            {
              principalId: "principal-owner",
              tenantId: projectId,
              tenantSlug: "project",
              kind: "user",
              status: "active",
            },
          ],
          nextCursor: null,
        } as T;
      }
      if (method === "GET" && pathname === `/api/tenants/${projectId}/roles`) {
        return { data: roles, nextCursor: null } as T;
      }
      if (method === "POST" && pathname === `/api/tenants/${projectId}/roles`) {
        const input = body as { name: string; description: string };
        const created: HubRole = {
          id: `role-${++roleSeq}`,
          name: input.name,
          description: input.description,
          isSystem: false,
        };
        roles.push(created);
        return created as T;
      }
      if (method === "GET" && pathname === `/api/tenants/${projectId}/grants`) {
        return { data: grants, nextCursor: null } as T;
      }
      if (method === "POST" && pathname === `/api/tenants/${projectId}/grants`) {
        const input = body as {
          roleId: string;
          resource: string;
          action: string;
          effect: HubGrant["effect"];
          origin: string;
        };
        const created: HubGrant = {
          id: `grant-${++grantSeq}`,
          roleId: input.roleId,
          principalId: null,
          resource: input.resource,
          action: input.action,
          effect: input.effect,
          origin: input.origin,
        };
        grants.push(created);
        return created as T;
      }
      if (method === "POST" && pathname.startsWith(`/api/tenants/${projectId}/principals/`)) {
        return undefined as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    subscribe() {
      return () => undefined;
    },
  };
}

describe("installProjectAuthority", () => {
  test("mints hold and named-signal grants per ledger role, and nothing for a role that does not hold the command", async () => {
    const transport = fakeProjectTransport("proj-1");
    await installProjectAuthority(transport, "proj-1", {
      costTolerancePercent: 10,
      costToleranceAbsolute: 0,
      audiences: [{ name: "users", role: "audience_member" }],
      audienceQuorum: 1,
      allowExternalProviders: false,
    });

    const byRole = new Map<string, HubGrant[]>();
    for (const role of transport.roles) byRole.set(role.name, []);
    for (const grant of transport.grants) {
      const role = transport.roles.find((entry) => entry.id === grant.roleId);
      if (!role) throw new Error(`grant ${grant.id} has no role`);
      byRole.get(role.name)!.push(grant);
    }

    for (const name of HUMANS) {
      const minted = byRole.get(name) ?? [];
      expect(minted.some((grant) => grant.resource === `authority:${name}` && grant.action === "hold")).toBe(
        true,
      );
      const expected = new Set(signalGrantsFor(name).map((grant) => `${grant.resource}\0${grant.action}`));
      const got = new Set(
        minted
          .filter((grant) => grant.resource === WORKFLOW_RUN_RESOURCE)
          .map((grant) => `${grant.resource}\0${grant.action}`),
      );
      expect(got).toEqual(expected);
    }

    const budget = byRole.get("budget_approver") ?? [];
    expect(
      budget.some(
        (grant) =>
          grant.resource === WORKFLOW_RUN_RESOURCE && grant.action === signalGrantAction(approveSignal(1)),
      ),
    ).toBe(false);
    expect(
      budget.some(
        (grant) =>
          grant.resource === WORKFLOW_RUN_RESOURCE && grant.action === signalGrantAction(approveSignal(7)),
      ),
    ).toBe(true);

    const audienceRole = byRole.get("audience:users") ?? [];
    expect(audienceRole).toEqual([]);
    expect(transport.roles.some((role) => role.name === "system")).toBe(false);
  });
});
