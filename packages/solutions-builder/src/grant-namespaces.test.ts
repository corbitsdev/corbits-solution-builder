import { describe, expect, test } from "bun:test";
import {
  INTERCHANGE_APP,
  SOLUTIONS_BUILDER_APP,
  assertMayMintGrant,
  assertMayRequireGrant,
} from "./grant-namespaces.js";

describe("grant namespaces", () => {
  test("an app mints under its own namespace", () => {
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "authority:project_owner")).not.toThrow();
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "artifact.read")).not.toThrow();
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "workflow-run:*")).not.toThrow();
    expect(() => assertMayMintGrant(INTERCHANGE_APP, "mail.send")).not.toThrow();
  });

  test("a mint outside the minter's own namespace is refused", () => {
    // Builder tools call platform surfaces, but only the platform mints there.
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "mail.send")).toThrow(/may not mint/);
    expect(() => assertMayMintGrant(SOLUTIONS_BUILDER_APP, "workflow.definitions")).toThrow(/may not mint/);
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
});
