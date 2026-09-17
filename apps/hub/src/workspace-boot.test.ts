import { describe, expect, test } from "bun:test";

describe("workspace boot", () => {
  test("does not create or retry a workspace tenant before listen", async () => {
    const source = await Bun.file(new URL("./workspace-boot.ts", import.meta.url)).text();
    expect(source).not.toContain("ensureWorkspaceOnce");
    expect(source).not.toContain("retryEnsureWorkspace");
    expect(source).toContain("export async function adoptLegacyWorkspaceOnce");
    expect(source).toContain("export async function migrateCredentialsOnce");
  });

  test("the host listens without minting an owner or a workspace tenant", async () => {
    const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();
    expect(source).not.toContain("ensureWorkspaceOnce");
    expect(source).not.toContain("retryEnsureWorkspace");
    expect(source).not.toContain("ensureOwner");
    expect(source).not.toContain("OWNER_EMAIL");
    expect(source).toContain("adoptLegacyWorkspaceOnce()");
    expect(source).toContain("migrateCredentialsOnce");
    expect(source).toContain("Workspace: not installed yet");
  });
});
