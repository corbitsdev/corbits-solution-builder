import { describe, expect, test, mock } from "bun:test";
import type { HubPrincipal } from "./hub-client.js";

const WORKSPACE = "t_workspace";
const PROJECT = "t_project";

type EvaluateCall = {
  readonly principalId: string;
  readonly resource: string;
  readonly action: string;
  readonly scope: string | undefined;
};

let workspacePrincipals: HubPrincipal[] = [];
let projectPrincipals: HubPrincipal[] = [];
let evaluateCalls: EvaluateCall[] = [];
let allowed: ReadonlySet<string> = new Set();

// `engine.js` is the command engine; only its host-principal constant is
// needed here, and loading the real module would drag the whole engine graph
// into a grant-scoping test. Our cases never act as the host, so any value
// distinct from the test principals would do; this mirrors the real one.
mock.module("./engine.js", () => ({ HOST_PRINCIPAL: "p_host" }));

// Stub the hub boundary: the tests pin what `authoritiesFor` asks of the
// hub, not what the hub answers. Only the names the loaded graph imports
// need to exist; the two fakes carry the behavior, the rest are inert.
mock.module("./hub-client.js", () => ({
  listPrincipals: async (scope?: string): Promise<HubPrincipal[]> =>
    scope === PROJECT ? projectPrincipals : workspacePrincipals,
  evaluate: async (
    principalId: string,
    resource: string,
    action: string,
    scope?: string,
  ): Promise<"allow" | "deny" | "ask"> => {
    evaluateCalls.push({ principalId, resource, action, scope });
    return allowed.has(`${scope}${resource}/${action}`) ? "allow" : "deny";
  },
  definitionIdFor: async (): Promise<string | null> => null,
  tenantId: (): string => WORKSPACE,
  LEGACY_TENANT_ID: "t_legacy",
}));

const { authoritiesFor } = await import("./engine-approvals.js");

function principal(id: string, tenantId: string, refId: string): HubPrincipal {
  return { id, tenantId, kind: "user", refId, status: "active", roles: [] };
}

describe("authoritiesFor single-tenant invariant", () => {
  test("an ancestor-tenant grant never authorizes the same action in a descendant project", async () => {
    // The actor exists in the ancestor workspace but was never put on the
    // project: no principal there, so nothing to evaluate. The stub evaluator
    // allows everything, standing in for the most permissive ancestor grant
    // imaginable — it must still authorize nothing here.
    workspacePrincipals = [principal("p_actor_ws", WORKSPACE, "u_actor")];
    projectPrincipals = [principal("p_other", PROJECT, "u_other")];
    evaluateCalls = [];
    allowed = new Set([`${PROJECT}authority:project_owner/hold`]);

    expect(await authoritiesFor(PROJECT, "p_actor_ws")).toEqual([]);
    expect(evaluateCalls).toEqual([]);
  });

  test("evaluation stays scoped to the project tenant and its principal", async () => {
    workspacePrincipals = [principal("p_actor_ws", WORKSPACE, "u_actor")];
    projectPrincipals = [
      principal("p_other", PROJECT, "u_other"),
      principal("p_actor_proj", PROJECT, "u_actor"),
    ];
    evaluateCalls = [];
    allowed = new Set([`${PROJECT}authority:project_owner/hold`]);

    expect(await authoritiesFor(PROJECT, "p_actor_ws")).toEqual(["project_owner"]);
    expect(evaluateCalls.length).toBeGreaterThan(0);
    for (const call of evaluateCalls) {
      expect(call.scope).toBe(PROJECT);
      expect(call.principalId).toBe("p_actor_proj");
    }
  });
});
