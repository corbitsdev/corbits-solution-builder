import { describe, expect, test } from "bun:test";

import { groupAlive, processStartedAt } from "./sidecar-unit.js";

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("processStartedAt", () => {
  test("names a running process by its start time", () => {
    expect(processStartedAt(process.pid)).toMatch(/\d{4}$/);
  });

  test("is null for a pid nothing has", () => {
    // The largest pid macOS or Linux hands out is far below this.
    expect(processStartedAt(2_147_483_000)).toBeNull();
  });

  // #898: a killed child is a zombie until its parent reaps it, which Bun
  // does on a later turn of the event loop. The kernel skips zombies when
  // signalling a group, so the provisioner sees the group gone while
  // `kill(pid, 0)` still succeeds and `ps` still prints a start time. A
  // zombie is an exited process, never a live sidecar.
  test("is null for a zombie, which kill(pid, 0) still answers for", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000);"], { detached: true, stdin: "ignore" });
    child.unref();
    const pid = child.pid;
    try {
      expect(processStartedAt(pid)).not.toBeNull();
      process.kill(-pid, "SIGKILL");
      // Synchronously, so the event loop cannot reap in between.
      const deadline = Date.now() + 2_000;
      while (groupAlive(pid) && Date.now() < deadline) {
        // The kill lands within a millisecond.
      }
      expect(groupAlive(pid)).toBe(false);
      expect(exists(pid)).toBe(true);
      expect(processStartedAt(pid)).toBeNull();
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await child.exited;
    }
  });
});
