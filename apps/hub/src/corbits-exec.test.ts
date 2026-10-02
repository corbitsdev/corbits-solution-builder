import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeAvailable, CANCEL_GRACE_MS, runBuildAttempt } from "./corbits-exec.js";

// A stand-in for the worker: answers the probe with the verb the bridge
// looks for, echoes its prompt as final text, and exits the way the test
// asks. Nothing here needs a coding agent installed.
const STAND_IN = `#!/bin/sh
case "$1" in
  --help) echo "usage: corbits exec <prompt>"; exit 0 ;;
  exec)
    echo "final text for: $2"
    echo "to stderr" >&2
    if [ -f ./SLEEP ]; then sleep 30; fi
    if [ -f ./FAIL ]; then exit 3; fi
    exit 0 ;;
esac
`;

let root: string;
let binary: string;
const previous = process.env.SOLUTIONS_BUILDER_WORKER_BIN;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bridge-"));
  binary = join(root, "corbits-stand-in");
  await writeFile(binary, STAND_IN);
  await chmod(binary, 0o755);
  process.env.SOLUTIONS_BUILDER_WORKER_BIN = binary;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.SOLUTIONS_BUILDER_WORKER_BIN;
  else process.env.SOLUTIONS_BUILDER_WORKER_BIN = previous;
  await rm(root, { recursive: true, force: true });
});

const onlyOnPosix = process.platform === "win32" ? test.skip : test;
const CANCEL_TIMEOUT_MS = CANCEL_GRACE_MS + 10_000;

describe("bridgeAvailable", () => {
  onlyOnPosix("an executable that answers the probe is available", async () => {
    const availability = await bridgeAvailable();
    expect(availability.available).toBe(true);
    expect(availability.install).toBeNull();
    expect(availability.worker.command).toBe(binary);
  });

  onlyOnPosix("an absent executable is unavailable, with how to get it", async () => {
    process.env.SOLUTIONS_BUILDER_WORKER_BIN = join(root, "not-here");
    try {
      const availability = await bridgeAvailable();
      expect(availability.available).toBe(false);
      expect(availability.detail).toContain("not installed, or not on this host's PATH");
      expect(availability.install?.binary).toBe("corbits");
      expect(availability.install?.platform).toBeDefined();
    } finally {
      process.env.SOLUTIONS_BUILDER_WORKER_BIN = binary;
    }
  });
});

describe("runBuildAttempt", () => {
  onlyOnPosix("reports the worker's final text, both pipes as they land, and its exit status", async () => {
    const workspace = join(root, "ok");
    const seen: string[] = [];
    const outcome = await runBuildAttempt({
      workspace,
      prompt: "build it",
      turnLog: join(root, "ok.turns.jsonl"),
      onOutput: (chunk, channel) => seen.push(`${channel}:${chunk.trim()}`),
    });
    expect(outcome.available).toBe(true);
    expect(outcome.exitStatus).toBe(0);
    expect(outcome.signal).toBeNull();
    expect(outcome.finalText).toBe("final text for: build it\n");
    expect(outcome.stderrTail).toContain("to stderr");
    expect(seen).toContain("stdout:final text for: build it");
    expect(seen).toContain("stderr:to stderr");
    expect(outcome.checkpointRef).toBeNull();
    // The hook for the worker's turn reports is placed in the workspace and ignored by git there.
    expect(await readFile(join(workspace, ".corbits/hooks/.gitignore"), "utf8")).toContain("solution-builder-turns.sh");
  });

  onlyOnPosix("a non-zero exit is reported as it was, not turned into an exception", async () => {
    const workspace = join(root, "fails");
    await runBuildAttempt({ workspace, prompt: "x", turnLog: join(root, "fails.turns.jsonl"), continueFrom: join(root, "ok") });
    await writeFile(join(workspace, "FAIL"), "");
    const outcome = await runBuildAttempt({ workspace, prompt: "again", turnLog: join(root, "fails.turns.jsonl") });
    expect(outcome.exitStatus).toBe(3);
    expect(outcome.finalText).toContain("final text for: again");
  });

  onlyOnPosix("a cancel ends the worker and records the signal, not an exit status", async () => {
    const workspace = join(root, "cancelled");
    await runBuildAttempt({ workspace, prompt: "x", turnLog: join(root, "c.turns.jsonl") });
    await writeFile(join(workspace, "SLEEP"), "");
    const controller = new AbortController();
    const started = Date.now();
    const running = runBuildAttempt({
      workspace,
      prompt: "long",
      turnLog: join(root, "c.turns.jsonl"),
      signal: controller.signal,
      onOutput: (chunk) => {
        if (chunk.includes("final text")) controller.abort();
      },
    });
    const outcome = await running;
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.exitStatus).toBeNull();
    // Well under the sleep: the tree was ended, by SIGTERM or the SIGKILL after the grace.
    expect(Date.now() - started).toBeLessThan(CANCEL_GRACE_MS + 5_000);
  }, CANCEL_TIMEOUT_MS);

  onlyOnPosix("a continued attempt copies the earlier one without the hook directory or caches", async () => {
    const from = join(root, "from");
    await runBuildAttempt({ workspace: from, prompt: "x", turnLog: join(root, "f.turns.jsonl") });
    await writeFile(join(from, "src.txt"), "kept");
    await Bun.write(join(from, "node_modules/dep/index.js"), "dropped");
    const workspace = join(root, "to");
    await runBuildAttempt({ workspace, prompt: "y", turnLog: join(root, "t.turns.jsonl"), continueFrom: from });
    expect(await readFile(join(workspace, "src.txt"), "utf8")).toBe("kept");
    expect(await Bun.file(join(workspace, "node_modules/dep/index.js")).exists()).toBe(false);
  });
});
