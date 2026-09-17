import { describe, expect, test } from "bun:test";

import type { GrantRule } from "@intx/types/authz";

import { credentialDelegationAllows, credentialUseResource } from "./model-source-resolution";

const CREDENTIAL_ID = "crd_workspace_openai";

function grant(overrides: Partial<GrantRule> & Pick<GrantRule, "resource" | "action" | "effect">): GrantRule {
  return {
    id: `grt_${Math.random().toString(36).slice(2, 10)}`,
    origin: "invoker",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
    ...overrides,
  };
}

describe("credentialUseResource", () => {
  test("names the credential's own `credential:<id>` resource", () => {
    expect(credentialUseResource(CREDENTIAL_ID)).toBe(`credential:${CREDENTIAL_ID}`);
  });
});

describe("credentialDelegationAllows — CL-8133", () => {
  test("no grants at all: fails closed", async () => {
    expect(await credentialDelegationAllows([], CREDENTIAL_ID)).toBe(false);
  });

  test("an exact-match allow on this credential's `use` authorizes it", async () => {
    const grants = [grant({ resource: credentialUseResource(CREDENTIAL_ID), action: "use", effect: "allow" })];
    expect(await credentialDelegationAllows(grants, CREDENTIAL_ID)).toBe(true);
  });

  test("a grant on a different credential does not authorize this one", async () => {
    const grants = [grant({ resource: credentialUseResource("crd_other"), action: "use", effect: "allow" })];
    expect(await credentialDelegationAllows(grants, CREDENTIAL_ID)).toBe(false);
  });

  test("read/create/manage grants do not authorize use (least privilege)", async () => {
    const grants = [
      grant({ resource: "*", action: "read", effect: "allow" }),
      grant({ resource: "*", action: "create", effect: "allow" }),
      grant({ resource: "*", action: "manage", effect: "allow" }),
    ];
    expect(await credentialDelegationAllows(grants, CREDENTIAL_ID)).toBe(false);
  });

  test("a deny at equal specificity beats an allow — revocation wins", async () => {
    const grants = [
      grant({ resource: credentialUseResource(CREDENTIAL_ID), action: "use", effect: "allow" }),
      grant({ resource: credentialUseResource(CREDENTIAL_ID), action: "use", effect: "deny" }),
    ];
    expect(await credentialDelegationAllows(grants, CREDENTIAL_ID)).toBe(false);
  });

  test("an empty grant set after revocation fails closed", async () => {
    // `revokeDelegationGrants` (installer/workbench-delegation.ts) deletes the
    // grant row outright rather than flipping it to deny, so the next
    // resolution simply sees nothing here — this is the shape that revoke
    // leaves behind.
    expect(await credentialDelegationAllows([], CREDENTIAL_ID)).toBe(false);
  });
});
