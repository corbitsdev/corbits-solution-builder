import { describe, expect, test } from "bun:test";
import { inheritedEnvironment } from "./host-environment.js";

describe("inheritedEnvironment", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/Users/someone",
    LANG: "en_GB.UTF-8",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "canary-encryption",
    HUB_REPO_SIGNING_KEY: "canary-signing",
    SIDECAR_ADAPTER_MANIFEST: "canary-manifest",
    ANTHROPIC_API_KEY: "sk-worker",
    CORBITS_HOME: "/Users/someone/.corbits",
    EMPTY: "",
  };

  test("passes what a program needs to run and nothing the host holds for itself", () => {
    const env = inheritedEnvironment([], host);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/someone", LANG: "en_GB.UTF-8", LC_ALL: "C", TMPDIR: "/tmp" });
    expect(JSON.stringify(env)).not.toContain("canary");
  });

  test("a worker's named sign-in variables ride along, by name or by prefix", () => {
    const env = inheritedEnvironment(["ANTHROPIC_API_KEY", "CORBITS_*"], host);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-worker");
    expect(env.CORBITS_HOME).toBe("/Users/someone/.corbits");
    expect(JSON.stringify(env)).not.toContain("canary");
  });
});
