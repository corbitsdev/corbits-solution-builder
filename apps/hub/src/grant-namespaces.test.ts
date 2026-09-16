import { describe, expect, test } from "bun:test";
import {
  INTERCHANGE_APP,
  SOLUTIONS_BUILDER_APP,
  assertMayMintGrant,
  assertMayRequireGrant,
} from "@solutions-builder/app/grant-namespaces";
import { STAGES, type Stage } from "@solutions-builder/app/ledger";
import { grantRequirementsFor } from "@solutions-builder/app/seed-kit";
import { ensureRoleGrant } from "./hub-client.js";

describe("grant namespaces", () => {
  test("an app mints under its own namespace", () => {
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "authority:project_owner")).not.toThrow();
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "artifact.read")).not.toThrow();
    expect(() => assertMayMintGrant(INTERCHANGE_APP, "mail.send")).not.toThrow();
  });

  test("a mint outside the minter's own namespace is refused", () => {
    // Builder tools call platform surfaces, but only the platform mints there.
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "mail.send")).toThrow(/may not mint/);
    expect(() => assertMayMintGrant("other-app", "artifact.read")).toThrow(/may not mint/);
    // Unknown prefixes mint for nobody: name the owner in the table first.
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "billing.charge")).toThrow(/may not mint/);
    expect(() => assertMayMintGrant(INTERCHANGE_APP, "billing.charge")).toThrow(/may not mint/);
    // The legacy `*` owner grant is grandfathered, never a precedent.
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "*")).toThrow(/may not mint/);
  });

  test("requiring is weaker than minting, but still namespaced", () => {
    // Builder may require the platform namespaces its tools call through.
    expect(() => assertMayRequireGrant(SOLUTIONS_BUILDER_APP, "conversation.append")).not.toThrow();
    expect(() => assertMayRequireGrant(SOLUTIONS_BUILDER_APP, "artifact.read")).not.toThrow();
    // Minting is the stronger power, so a minter may also require its own.
    expect(() => assertMayRequireGrant(SOLUTIONS_BUILDER_APP, "authority:project_owner")).not.toThrow();
    // Another app's namespace and unknown prefixes are refused even to require.
    expect(() => assertMayRequireGrant("other-app", "artifact.read")).toThrow(/may not require/);
    expect(() => assertMayRequireGrant(SOLUTIONS_BUILDER_APP, "billing.charge")).toThrow(
      /may not require/,
    );
  });

  test("every stage's requirements stay inside a requirable namespace", () => {
    for (const stage of STAGES as readonly Stage[]) {
      for (const requirement of grantRequirementsFor(stage)) {
        expect(() =>
          assertMayRequireGrant(SOLUTIONS_BUILDER_APP, requirement.resource),
        ).not.toThrow();
      }
    }
  });

  test("the hub's grant funnel refuses before any write", async () => {
    await expect(
      ensureRoleGrant({
        roleId: "role_other_app",
        resource: "mail.send",
        action: "send",
        effect: "allow",
        origin: "role",
      }),
    ).rejects.toThrow(/may not mint/);
  });
});
