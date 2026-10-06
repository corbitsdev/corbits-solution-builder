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
    // The record says a person cancelled it, not that the worker crashed.
    expect((await attemptRecord("proj_race", 1))?.endedBy).toBe("cancel");
  }, CANCEL_GRACE_MS + 15_000);

  // #783: a worker an earlier host run left running is followed again, and
  // one that ended while no host was there is recorded from its files.
  onlyOnPosix("an attempt an earlier host run started is followed again while its group lives, and cancel reaches it", async () => {
    const { attemptRecord, cancelBuildAttempt, projectBuildsDirectory, projectHasRunningAttempt, attemptLog } = await import("./build-attempts.js");
    const directory = projectBuildsDirectory("proj_restart");
    await mkdir(join(directory, "1"), { recursive: true });
    // Stands in for the worker a previous host run left behind: alive, in its own group.
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = orphan.pid!;
    await writeFile(join(directory, "1.log"), "earlier output\n");
    await writeFile(join(directory, "1.started.json"), JSON.stringify({ startedAt: new Date().toISOString(), continuedFrom: null, pid: pgid, pgid, worker: "corbits-code", command: "corbits" }));
    expect((await attemptRecord("proj_restart", 1))?.state).toBe("running");
    expect(await projectHasRunningAttempt("proj_restart")).toBe(true);
    expect(await attemptLog("proj_restart", 1)).toContain("earlier output");
    expect(await attemptLog("proj_restart", 1)).toContain("the host started again and is following the worker from here");

    expect(await cancelBuildAttempt("proj_restart", 1)).toBe(true);
    await until(async () => (await attemptRecord("proj_restart", 1))?.state === "ended", CANCEL_GRACE_MS + 5_000);
    const record = await attemptRecord("proj_restart", 1);
    expect(record?.endedBy).toBe("cancel");
    expect(record?.outcome?.worker).toBe("corbits-code");
    // Killed outright, it left no exit status; the record says so rather than inventing one.
    expect(record?.outcome?.exitStatus).toBeNull();

    // A record whose process is gone without an exit is lost, not running and not ended.
    await writeFile(join(directory, "2.started.json"), JSON.stringify({ startedAt: new Date().toISOString(), continuedFrom: null, pid: null, pgid: null }));
    await mkdir(join(directory, "2"), { recursive: true });
    expect((await attemptRecord("proj_restart", 2))?.state).toBe("lost");
    expect(await cancelBuildAttempt("proj_restart", 2)).toBe(false);

    // A worker that ended while no host was there left its exit and output in its files.
    const gone = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => gone.once("exit", resolve));
    await mkdir(join(directory, "3"), { recursive: true });
    await writeFile(join(directory, "3.started.json"), JSON.stringify({ startedAt: "2026-10-05T17:09:15.718Z", continuedFrom: 1, pid: gone.pid, pgid: gone.pid, worker: "corbits-code", command: "corbits" }));
    await writeFile(join(directory, "3.stdout"), "all done\n");
    await writeFile(join(directory, "3.stderr"), "");
    await writeFile(join(directory, "3.exit"), "0\n");
    await writeFile(join(directory, "3.turns.jsonl"), `${JSON.stringify({ turnIndex: 0, toolCalls: [{ id: "a", name: "bash" }, { id: "b", name: "read" }] })}\n${JSON.stringify({ turnIndex: 1, toolCalls: [] })}\n`);
    await until(async () => (await attemptRecord("proj_restart", 3))?.state === "ended", 10_000);
    const ended = await attemptRecord("proj_restart", 3);
    expect(ended?.outcome).toMatchObject({ exitStatus: 0, signal: null, finalText: "all done\n", turns: 2, toolCalls: 2, startedAt: "2026-10-05T17:09:15.718Z", worker: "corbits-code" });
    expect(ended?.continuedFrom).toBe(1);
    expect(ended?.endedBy).toBeNull();
  }, CANCEL_GRACE_MS + 15_000);
  onlyOnPosix("the worker's pid and group are recorded once it is up; stopping the host leaves every attempt running, one just starting too, and nothing starts after", async () => {
    const { startBuildAttempt, attemptRecord, stopBuildAttempts, projectBuildsDirectory, cancelBuildAttempt, attemptLog } = await import("./build-attempts.js");
    const started = await startBuildAttempt({ projectId: "proj_stop", prompt: PROMPT });
    expect(started.state).toBe("running");
    const startedFile = join(projectBuildsDirectory("proj_stop"), "1.started.json");
    await until(async () => typeof (JSON.parse(await readFile(startedFile, "utf8")) as { pid: unknown }).pid === "number", 5_000);
    const recorded = JSON.parse(await readFile(startedFile, "utf8")) as { pid: number; pgid: number; worker: string };
    expect(recorded.pgid).toBe(recorded.pid);
    expect(recorded.worker).toBe("corbits-code");

    // A second start lands in the same tick as the stop: reserved, not yet in flight.
    const justStarting = startBuildAttempt({ projectId: "proj_stopstart", prompt: PROMPT });
    await stopBuildAttempts();
    await justStarting;

    for (const projectId of ["proj_stop", "proj_stopstart"]) {
      // Released, not ended (#783): the worker is still there, in its own
      // group, writing to its files; this host, stopping, no longer follows it.
      const record = await attemptRecord(projectId, 1);
      expect(record?.state).toBe("detached");
      expect(await Bun.file(join(projectBuildsDirectory(projectId), "1.json")).exists()).toBe(false);
      expect(await attemptLog(projectId, 1)).toContain("the host is stopping; the worker runs on");
      const { pgid } = JSON.parse(await readFile(join(projectBuildsDirectory(projectId), "1.started.json"), "utf8")) as { pgid: number };
      expect(() => process.kill(-pgid, 0)).not.toThrow();
      // Cancel still reaches it by group, which is also this test's cleanup.
      expect(await cancelBuildAttempt(projectId, 1)).toBe(true);
      await until(async () => !(() => { try { process.kill(-pgid, 0); return true; } catch { return false; } })(), CANCEL_GRACE_MS + 5_000);
    }
    // Nothing starts once the host is stopping.
    await expect(startBuildAttempt({ projectId: "proj_after_stop", prompt: PROMPT })).rejects.toThrow(/host is stopping/);
  }, CANCEL_GRACE_MS + 20_000);

});
