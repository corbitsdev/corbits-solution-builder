import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartedAt } from "@corbits/embed-hub/sidecar-unit";
import { sidecarPidFiles, stopSpawnedSidecars } from "./sidecar-processes.ts";

let hub: string;
beforeEach(async () => {
  hub = await mkdtemp(join(tmpdir(), "sb-hub-"));
});
afterEach(async () => {
  await rm(hub, { recursive: true, force: true });
});

async function pidFile(dir: string, allocation: string, generation: string, pid: string, startedAt?: string): Promise<void> {
  const at = join(hub, dir, "allocations", allocation, generation);
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "sidecar.pid"), pid);
  if (startedAt !== undefined) await writeFile(join(at, "sidecar.start"), `${startedAt}\n`);
}

describe("sidecarPidFiles", () => {
  test("finds each allocation's generation pid files, in both provisioner trees", async () => {
    await pidFile("process-provisioner", "sal_a", "gen-0", "100");
    await pidFile("process-provisioner", "sal_a", "gen-1", "101");
    await pidFile("process-provisioner-probe", "sal_p", "gen-0", "200");
    const found = (await sidecarPidFiles(hub)).map((file) => file.slice(hub.length + 1)).sort();
    expect(found).toEqual([
      "process-provisioner-probe/allocations/sal_p/gen-0/sidecar.pid",
      "process-provisioner/allocations/sal_a/gen-0/sidecar.pid",
      "process-provisioner/allocations/sal_a/gen-1/sidecar.pid",
    ]);
  });

  // #146: the closure under a generation is thousands of files; nothing
  // below the generation directory is read, and a pid file that is not the
  // provisioner's is not one of ours.
  test("never descends into a generation's data, and ignores pid files elsewhere", async () => {
    await pidFile("process-provisioner", "sal_a", "gen-0", "100");
    const deep = join(hub, "process-provisioner", "allocations", "sal_a", "gen-0", "data", "closures", "x", "node_modules", "pkg");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "sidecar.pid"), "999");
    await mkdir(join(hub, "process-provisioner", "allocations", "sal_b", "scratch"), { recursive: true });
    await writeFile(join(hub, "process-provisioner", "allocations", "sal_b", "scratch", "sidecar.pid"), "998");
    await writeFile(join(hub, "process-provisioner", "allocations", "sidecar.pid"), "997");
    const found = await sidecarPidFiles(hub);
    expect(found).toHaveLength(1);
    expect(found[0]).toEndWith(join("sal_a", "gen-0", "sidecar.pid"));
  });

  test("a hub directory with no allocations yet is empty, not an error", async () => {
    expect(await sidecarPidFiles(join(hub, "missing"))).toEqual([]);
  });
});

describe("stopSpawnedSidecars", () => {
  test("offers every recorded process once, with its start time, and counts the ones stopped", async () => {
    await pidFile("process-provisioner", "sal_a", "gen-0", "100\n", "Thu Jan  1 00:00:00 1970");
    await pidFile("process-provisioner", "sal_b", "gen-3", "not-a-pid");
    await pidFile("process-provisioner", "sal_c", "gen-0", "0");
    await pidFile("process-provisioner-probe", "sal_p", "gen-0", "200");
    const offered: Array<[number, string | null]> = [];
    const stopped = await stopSpawnedSidecars(hub, (sidecar) => {
      offered.push([sidecar.pid, sidecar.startedAt]);
      return sidecar.pid !== 200;
    });
    expect(offered.sort()).toEqual([
      [100, "Thu Jan  1 00:00:00 1970"],
      [200, null],
    ]);
    expect(stopped).toBe(1);
  });

  test("stops the whole group of a sidecar it started, and leaves a pid that is no longer the sidecar's alone", async () => {
    // Both lead a group of their own, as a provisioned sidecar does. The
    // second's record names a start time it does not have: a pid file left by
    // a crash or a reboot, since reissued to something that is not ours.
    const ours = Bun.spawn(["sleep", "60"], { detached: true, stdin: "ignore" });
    const stranger = Bun.spawn(["sleep", "60"], { detached: true, stdin: "ignore" });
    try {
      await pidFile("process-provisioner", "sal_a", "gen-0", String(ours.pid), processStartedAt(ours.pid)!);
      await pidFile("process-provisioner", "sal_b", "gen-0", String(stranger.pid), "Thu Jan  1 00:00:00 1970");

      expect(await stopSpawnedSidecars(hub)).toBe(1);

      await ours.exited;
      expect(ours.signalCode).toBe("SIGTERM");
      expect(isRunning(stranger.pid)).toBe(true);
    } finally {
      ours.kill("SIGKILL");
      stranger.kill("SIGKILL");
    }
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
