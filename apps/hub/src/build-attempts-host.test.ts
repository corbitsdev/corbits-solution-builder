import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANCEL_GRACE_MS } from "./corbits-exec.js";

// A stand-in worker: answers the probe, then sleeps until it is signalled.
const STAND_IN = `#!/bin/sh
case "$1" in
  --help) echo "usage: corbits exec <prompt>"; exit 0 ;;
  exec) echo "working on: $(cat .corbits/solution-builder-prompt.md)"; sleep 30; exit 0 ;;
esac
`;

let root: string;
const previous = { bin: process.env.SOLUTIONS_BUILDER_WORKER_BIN, builds: process.env.SOLUTIONS_BUILDER_BUILDS_DIR };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "build-attempts-host-"));
  const binary = join(root, "corbits-stand-in");
  await writeFile(binary, STAND_IN);
  await chmod(binary, 0o755);
  process.env.SOLUTIONS_BUILDER_WORKER_BIN = binary;
  process.env.SOLUTIONS_BUILDER_BUILDS_DIR = join(root, "builds");
});

afterAll(async () => {
  for (const [name, value] of [
    ["SOLUTIONS_BUILDER_WORKER_BIN", previous.bin],
    ["SOLUTIONS_BUILDER_BUILDS_DIR", previous.builds],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const onlyOnPosix = process.platform === "win32" ? test.skip : test;
const PROMPT = { planText: "# Plan\nBuild it.", requirementsText: "", designText: "", stackBlock: "", target: "web", planRef: "art@1", continuing: false };

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("the host's build attempts", () => {
  onlyOnPosix("an empty plan is refused before anything is written", async () => {
    const { startBuildAttempt, listAttempts } = await import("./build-attempts.js");
    await expect(startBuildAttempt({ projectId: "proj_empty", prompt: { ...PROMPT, planText: "  \n" } })).rejects.toThrow(/approved plan has no text/);
    expect(await listAttempts("proj_empty")).toEqual([]);
  });

  onlyOnPosix("two starts that land together get one attempt, not two with the same number", async () => {
    const { startBuildAttempt, listAttempts, cancelBuildAttempt, attemptRecord } = await import("./build-attempts.js");
    const results = await Promise.allSettled([
      startBuildAttempt({ projectId: "proj_race", prompt: PROMPT }),
      startBuildAttempt({ projectId: "proj_race", prompt: PROMPT }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await listAttempts("proj_race")).map((record) => record.attempt)).toEqual([1]);
    // Ended by cancel, not by stopping the host: a stopped host starts nothing more.
    expect(await cancelBuildAttempt("proj_race", 1)).toBe(true);
    await until(async () => (await attemptRecord("proj_race", 1))?.state === "ended", CANCEL_GRACE_MS + 5_000);
  }, CANCEL_GRACE_MS + 15_000);

  onlyOnPosix("an attempt an earlier host run started is detached while its group lives, lost once it is gone, and cancel reaches it", async () => {
    const { attemptRecord, cancelBuildAttempt, projectBuildsDirectory, projectHasRunningAttempt } = await import("./build-attempts.js");
    const directory = projectBuildsDirectory("proj_restart");
    await mkdir(join(directory, "1"), { recursive: true });
    // Stands in for the worker a previous host run left behind: alive, in its own group.
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = orphan.pid!;
    await writeFile(join(directory, "1.started.json"), JSON.stringify({ startedAt: new Date().toISOString(), continuedFrom: null, pid: pgid, pgid }));
    expect((await attemptRecord("proj_restart", 1))?.state).toBe("detached");
    // A live detached worker counts as running: no second worker beside it.
    expect(await projectHasRunningAttempt("proj_restart")).toBe(true);

    expect(await cancelBuildAttempt("proj_restart", 1)).toBe(true);
    await until(async () => (await attemptRecord("proj_restart", 1))?.state === "lost", CANCEL_GRACE_MS + 5_000);

    // A record whose process is gone is lost, not running and not ended.
    await writeFile(join(directory, "2.started.json"), JSON.stringify({ startedAt: new Date().toISOString(), continuedFrom: null, pid: null, pgid: null }));
    await mkdir(join(directory, "2"), { recursive: true });
    expect((await attemptRecord("proj_restart", 2))?.state).toBe("lost");
    expect(await cancelBuildAttempt("proj_restart", 2)).toBe(false);
  }, CANCEL_GRACE_MS + 15_000);
  onlyOnPosix("the worker's pid and group are recorded once it is up; stopping the host ends every attempt, one just starting too, and nothing starts after", async () => {
    const { startBuildAttempt, attemptRecord, stopBuildAttempts, projectBuildsDirectory } = await import("./build-attempts.js");
    const started = await startBuildAttempt({ projectId: "proj_stop", prompt: PROMPT });
    expect(started.state).toBe("running");
    const startedFile = join(projectBuildsDirectory("proj_stop"), "1.started.json");
    await until(async () => typeof (JSON.parse(await readFile(startedFile, "utf8")) as { pid: unknown }).pid === "number", 5_000);
    const recorded = JSON.parse(await readFile(startedFile, "utf8")) as { pid: number; pgid: number };
    expect(recorded.pgid).toBe(recorded.pid);

    // A second start lands in the same tick as the stop: reserved, not yet in flight.
    const justStarting = startBuildAttempt({ projectId: "proj_stopstart", prompt: PROMPT });
    await stopBuildAttempts();
    await justStarting;

    for (const projectId of ["proj_stop", "proj_stopstart"]) {
      const record = await attemptRecord(projectId, 1);
      expect(record?.state).toBe("ended");
      expect(record?.outcome?.signal).toBe("SIGTERM");
      const { pid } = JSON.parse(await readFile(join(projectBuildsDirectory(projectId), "1.started.json"), "utf8")) as { pid: number | null };
      // And the worker is gone, not left to run on without a host.
      if (pid !== null) expect(() => process.kill(pid, 0)).toThrow();
    }
    // Nothing starts once the host is stopping.
    await expect(startBuildAttempt({ projectId: "proj_after_stop", prompt: PROMPT })).rejects.toThrow(/host is stopping/);
  }, CANCEL_GRACE_MS + 20_000);

});
