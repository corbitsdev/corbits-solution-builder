import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SidecarProvisioner } from "@intx/hub-sessions";

import { createProcessProvisioner, type SidecarProcessRunner } from "./process-provisioner.js";

function fakeRunner() {
  let nextPid = 1000;
  const alive = new Set<number>();
  const runner: SidecarProcessRunner = {
    spawn: () => {
      alive.add(++nextPid);
      return nextPid;
    },
    isAlive: (pid) => alive.has(pid),
    signal: (pid) => void alive.delete(pid),
  };
  return { runner, alive };
}

let dataDir: string;
let alive: Set<number>;
let provisioner: SidecarProvisioner;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "process-provisioner-"));
  const fake = fakeRunner();
  alive = fake.alive;
  provisioner = create(fake.runner);
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

function create(runner: SidecarProcessRunner): SidecarProvisioner {
  return createProcessProvisioner({
    role: "deployment",
    dataDir,
    runtimePath: "/bin/bun",
    sidecarEntryPath: "/sidecar/index.ts",
    hubWebSocketUrl: "ws://127.0.0.1:1/api/sidecars/ws",
    runner,
    terminationGraceMs: 10,
  });
}

const ensure = (generation: number, sidecarId: string) =>
  provisioner.ensure({
    allocationId: "sal_a",
    generation,
    sidecarId,
    tenantId: "tnt_a",
    anchorRunId: "run_a",
    token: `token-${sidecarId}`,
    hubWebSocketUrl: "ws://127.0.0.1:1/api/sidecars/ws",
  });
const destroy = (generation: number, sidecarId: string) =>
  provisioner.destroy({ allocationId: "sal_a", generation, sidecarId });

describe("process provisioner", () => {
  test("accepts a new identity after destroying the old identity at the replacement generation", async () => {
    expect(await ensure(1, "sc_old")).toMatchObject({ kind: "accepted" });
    expect(await destroy(2, "sc_old")).toEqual({ kind: "destroyed" });
    expect(alive.size).toBe(0);
    expect(await ensure(2, "sc_new")).toMatchObject({ kind: "accepted" });
    expect(alive.size).toBe(1);
    expect((await readFile(join(dataDir, "allocations/sal_a/gen-2/sidecar.id"), "utf8")).trim()).toBe("sc_new");
  });

  test("replaces a unit a previous host left behind", async () => {
    await ensure(1, "sc_old");
    const fresh = fakeRunner();
    provisioner = create(fresh.runner);
    expect(await destroy(2, "sc_old")).toEqual({ kind: "destroyed" });
    expect(await ensure(2, "sc_new")).toMatchObject({ kind: "accepted" });
    expect(fresh.alive.size).toBe(1);
  });

  test("reuses the live process for a repeated ensure", async () => {
    const first = await ensure(1, "sc_a");
    expect(await ensure(1, "sc_a")).toEqual(first);
    expect(alive.size).toBe(1);
  });

  test("fences the destroyed identity and older generations", async () => {
    await ensure(1, "sc_old");
    await destroy(2, "sc_old");
    expect(await ensure(2, "sc_old")).toMatchObject({ kind: "rejected", code: "generation_destroyed" });
    await ensure(2, "sc_new");
    expect(await ensure(1, "sc_old")).toMatchObject({ kind: "rejected", code: "stale_generation" });
  });

  test("a late destroy of the superseded identity leaves the replacement running", async () => {
    await destroy(2, "sc_old");
    await ensure(2, "sc_new");
    expect(await destroy(2, "sc_old")).toEqual({ kind: "destroyed" });
    expect(alive.size).toBe(1);
  });

  test("refuses a second identity for a generation that is already running", async () => {
    await ensure(1, "sc_a");
    expect(await ensure(1, "sc_b")).toMatchObject({ kind: "rejected", code: "sidecar_identity_conflict" });
  });

  test("keeps the binding fingerprint allocations were bound under", () => {
    expect(provisioner.bindingFingerprint).toBe("process:v1:deployment");
  });

  test("a destroyed generation leaves none of its process tree running", async () => {
    // A sidecar that ignores SIGTERM and has a child of its own, as a sidecar
    // has its workflow processes.
    const entry = join(dataDir, "sidecar.ts");
    await writeFile(
      entry,
      [
        'process.on("SIGTERM", () => {});',
        'const child = Bun.spawn(["sleep", "60"], { stdin: "ignore" });',
        'await Bun.write(Bun.env.SIDECAR_DATA_DIR + "/child.pid", String(child.pid));',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    provisioner = createProcessProvisioner({
      role: "deployment",
      dataDir,
      runtimePath: process.execPath,
      sidecarEntryPath: entry,
      hubWebSocketUrl: "ws://127.0.0.1:1/api/sidecars/ws",
      terminationGraceMs: 200,
    });
    const accepted = await ensure(1, "sc_old");
    if (accepted.kind !== "accepted") throw new Error(accepted.message);
    const sidecarPid = Number(accepted.externalRef?.split(":")[2]);
    const childPidFile = join(dataDir, "allocations/sal_a/gen-1/data/child.pid");
    let childPid = 0;
    for (let i = 0; i < 100 && childPid === 0; i++) {
      childPid = Number(await readFile(childPidFile, "utf8").catch(() => "0"));
      if (childPid === 0) await Bun.sleep(50);
    }
    expect(childPid).toBeGreaterThan(0);

    expect(await destroy(2, "sc_old")).toEqual({ kind: "destroyed" });
    expect(isRunning(sidecarPid)).toBe(false);
    expect(isRunning(childPid)).toBe(false);
  }, 10_000);
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
