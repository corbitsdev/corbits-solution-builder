import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A data directory of this test's own, claimed before any host module reads
// `SOLUTIONS_BUILDER_DATA_DIR`, so build workspaces land in a scratch
// directory rather than the developer's own.
const dataDir = await mkdtemp(join(tmpdir(), "corbits-exec-test-data-"));
process.env.SOLUTIONS_BUILDER_DATA_DIR = dataDir;

const { runBuildAttempt, snapshotWorkspace } = await import("./corbits-exec.js");

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-exec-test-ws-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("snapshotWorkspace on a git repo with an unborn HEAD", () => {
  test("reports state instead of throwing when a repo exists but has no commits", async () => {
    const workspace = await tempWorkspace();
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
    expect(init.success).toBe(true);
    // No commit is made: this is exactly the state a failed baseline commit
    // in build-workspace.ts leaves behind — `.git/` present, HEAD unborn.
    await writeFile(join(workspace, "README.md"), "hello\n");

    const fingerprint = await snapshotWorkspace(workspace);

    expect(fingerprint).toContain("unborn");
    expect(fingerprint).toContain("README.md");
  });

  test("a fingerprint taken again after a commit differs, and still does not throw", async () => {
    const workspace = await tempWorkspace();
    Bun.spawnSync(["git", "init", "-q"], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
    await writeFile(join(workspace, "README.md"), "hello\n");
    const before = await snapshotWorkspace(workspace);

    Bun.spawnSync(["git", "add", "-A"], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@localhost",
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "baseline",
      ],
      { cwd: workspace, stdout: "pipe", stderr: "pipe" },
    );
    const after = await snapshotWorkspace(workspace);

    expect(before).toContain("unborn");
    expect(after).not.toContain("unborn");
    expect(after).not.toBe(before);
  });

  test("a genuinely broken git invocation still throws", async () => {
    const workspace = await tempWorkspace();
    // `.git` exists but is not a repository git recognises: `git status`
    // itself fails here, which is the case this must still surface.
    await Bun.write(join(workspace, ".git"), "not a git dir");

    await expect(snapshotWorkspace(workspace)).rejects.toThrow();
  });
});

describe("runBuildAttempt bounds a single invocation by the wall-clock budget", () => {
  let bin: string;
  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), "corbits-exec-test-bin-"));
  });
  afterEach(() => {
    delete process.env.SOLUTIONS_BUILDER_WORKER_BIN;
  });

  test(
    "a worker that ignores SIGTERM is killed and the attempt stops on the wall-clock budget",
    async () => {
      const stubborn = join(bin, "stubborn-worker");
      await writeFile(
        stubborn,
        [
          "#!/bin/sh",
          "trap '' TERM",
          'case "$1" in',
          '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;',
          "  exec) echo started; sleep 30 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(stubborn, 0o755);
      process.env.SOLUTIONS_BUILDER_WORKER_BIN = stubborn;

      const startedAt = Date.now();
      const outcome = await runBuildAttempt({
        runId: `run-${Date.now()}`,
        prompt: "build it",
        seed: { title: "wall clock test", plan: "plan", requirements: "reqs" },
        continuation: { maxWallClockMs: 300 },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(outcome.available).toBe(true);
      expect(outcome.stopReason).toBe("wall_clock_budget");
      expect(outcome.continuations).toBe(0);
      // Bounded by the budget plus the kill escalation's own grace periods,
      // not by the worker's 30s sleep: proves the deadline reached inside
      // the invocation and the SIGKILL escalation actually ended it.
      expect(elapsedMs).toBeLessThan(20_000);
    },
    25_000,
  );
});
