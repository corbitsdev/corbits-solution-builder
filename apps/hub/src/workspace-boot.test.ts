import { describe, expect, test } from "bun:test";
import * as workspaceBoot from "./workspace-boot.js";

describe("workspace boot", () => {
  test("does not create or retry a workspace tenant before listen", () => {
    expect("ensureWorkspaceOnce" in workspaceBoot).toBe(false);
    expect("retryEnsureWorkspace" in workspaceBoot).toBe(false);
  });

  test("legacy adopt and credential migration remain host-only repairs", () => {
    expect(typeof workspaceBoot.adoptLegacyWorkspaceOnce).toBe("function");
    expect(typeof workspaceBoot.migrateCredentialsOnce).toBe("function");
  });

  test("the host listens without a workspace tenant", async () => {
    const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();
    expect(source).not.toContain("ensureWorkspaceOnce");
    expect(source).not.toContain("retryEnsureWorkspace");
    expect(source).toContain("await ensureOwner()");
    expect(source).toContain("await adoptLegacyWorkspaceOnce()");
    expect(source).toContain("migrateCredentialsOnce");
    expect(source).toContain('Workspace: not installed yet');
  });
});
