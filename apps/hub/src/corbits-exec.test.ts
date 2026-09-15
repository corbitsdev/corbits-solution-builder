import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("runBuildAttempt stops on the deliverable's own checks, not on silence", () => {
  let bin: string;
  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), "corbits-exec-test-check-bin-"));
  });
  afterEach(() => {
    delete process.env.SOLUTIONS_BUILDER_WORKER_BIN;
  });

  test(
    "a working deliverable stops the loop as complete after the first invocation",
    async () => {
      const worker = join(bin, "one-shot-worker");
      await writeFile(
        worker,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;',
          "  exec)",
          "    mkdir -p src",
          '    printf \'{"name":"w","scripts":{"start":"bun run src/cli.ts","test":"exit 0","typecheck":"exit 0"}}\' > package.json',
          "    echo 'console.log(\"built the thing\")' > src/cli.ts",
          "    echo done",
          "    ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(worker, 0o755);
      process.env.SOLUTIONS_BUILDER_WORKER_BIN = worker;

      const outcome = await runBuildAttempt({
        runId: `run-${Date.now()}`,
        prompt: "build it",
        seed: { title: "complete test", plan: "plan", requirements: "reqs" },
      });

      expect(outcome.available).toBe(true);
      expect(outcome.stopReason).toBe("complete");
      expect(outcome.continuations).toBe(0);
      expect(outcome.execution).not.toBeNull();
      expect(outcome.execution?.every((check) => check.ok)).toBe(true);
    },
    30_000,
  );

  test(
    "a failing check keeps the loop going and its failure reaches the next prompt",
    async () => {
      const worker = join(bin, "fixes-on-second-turn-worker");
      const promptLog = join(bin, "prompt-received.txt");
      await writeFile(
        worker,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;',
          "  exec)",
          "    if [ ! -f src/cli.ts ]; then",
          "      mkdir -p src",
          '      printf \'{"name":"w","scripts":{"start":"bun run src/cli.ts","test":"exit 1","typecheck":"exit 0"}}\' > package.json',
          "      echo 'console.log(\"built the thing\")' > src/cli.ts",
          "      echo 'first turn'",
          "    else",
          `      printf '%s' "$2" > ${JSON.stringify(promptLog)}`,
          '      printf \'{"name":"w","scripts":{"start":"bun run src/cli.ts","test":"exit 0","typecheck":"exit 0"}}\' > package.json',
          "      echo 'second turn'",
          "    fi",
          "    ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(worker, 0o755);
      process.env.SOLUTIONS_BUILDER_WORKER_BIN = worker;

      const outcome = await runBuildAttempt({
        runId: `run-${Date.now()}`,
        prompt: "build it",
        seed: { title: "fed-back failure test", plan: "plan", requirements: "reqs" },
      });

      expect(outcome.available).toBe(true);
      expect(outcome.stopReason).toBe("complete");
      expect(outcome.continuations).toBe(1);

      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("test");
      expect(prompt).toContain("bun run --silent test");
      expect(prompt).toContain("exit 1");
    },
    30_000,
  );

  test(
    "a seeded-but-empty workspace never reports complete: passing test/typecheck scripts on nothing built is not evidence of a deliverable",
    async () => {
      const worker = join(bin, "seeded-but-empty-worker");
      await writeFile(
        worker,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;',
          "  exec)",
          "    if [ ! -f package.json ]; then",
          // Exactly the reported bug's shape: scripts that pass trivially,
          // plus the seeded toolchain (tsconfig.json and a types/global.d.ts
          // stub, written so `tsc --noEmit` doesn't hard-error on an empty
          // project) — no src/, no entry point, no real deliverable.
          '      printf \'{"name":"w","scripts":{"test":"bun test","typecheck":"exit 0"}}\' > package.json',
          '      printf \'{"compilerOptions":{"strict":true,"noEmit":true},"include":["apps","packages","types"]}\' > tsconfig.json',
          "      mkdir -p types",
          "      printf 'export {};' > types/global.d.ts",
          "      echo 'wrote package.json but nothing else'",
          "    else",
          "      echo 'nothing left to do'",
          "    fi",
          "    ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(worker, 0o755);
      process.env.SOLUTIONS_BUILDER_WORKER_BIN = worker;

      const outcome = await runBuildAttempt({
        runId: `run-${Date.now()}`,
        prompt: "build it",
        seed: { title: "seeded but empty test", plan: "plan", requirements: "reqs" },
        continuation: { maxStaleContinuations: 1 },
      });

      expect(outcome.available).toBe(true);
      expect(outcome.stopReason).not.toBe("complete");
      expect(outcome.stopReason).toBe("stalled");
      expect(outcome.execution?.every((check) => check.ok)).toBe(true);
      expect(outcome.execution?.every((check) => check.vacuous)).toBe(true);
    },
    30_000,
  );

  test(
    "no discoverable check never reports complete; the loop stalls instead once the workspace stops changing",
    async () => {
      const worker = join(bin, "no-checks-worker");
      await writeFile(
        worker,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;',
          "  exec) echo 'nothing runnable here'; exit 0 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(worker, 0o755);
      process.env.SOLUTIONS_BUILDER_WORKER_BIN = worker;

      const outcome = await runBuildAttempt({
        runId: `run-${Date.now()}`,
        prompt: "build it",
        seed: { title: "no checks test", plan: "plan", requirements: "reqs" },
        continuation: { maxStaleContinuations: 1 },
      });

      expect(outcome.available).toBe(true);
      expect(outcome.stopReason).toBe("stalled");
      // Seeding always declares `test` and `typecheck`, so checks are always
      // discovered — they just prove nothing on a workspace nobody built in.
      // What matters is that proving nothing never reads as done.
      expect(outcome.execution?.every((check) => check.vacuous)).toBe(true);
      expect(outcome.stopReason).not.toBe("complete");
    },
    30_000,
  );
});
