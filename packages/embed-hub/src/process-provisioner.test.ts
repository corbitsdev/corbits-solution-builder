import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SidecarProvisioner } from "@intx/hub-sessions";

import { createProcessProvisioner, type SidecarProcessRunner } from "./process-provisioner.js";
import { processStartedAt } from "./sidecar-unit.js";

type FakeOptions = {
  readonly firstPid?: number;
  /** The sidecar ignores SIGTERM, as one busy with a workflow might. */
  readonly ignoresTerm?: boolean;
  /** SIGTERM ends the sidecar but its children live on until SIGKILL. */
  readonly childrenOutliveTerm?: boolean;
  /** Nothing ends the group, not even SIGKILL. */
  readonly unstoppable?: boolean;
};

function fakeRunner(options: FakeOptions = {}) {
  let nextPid = (options.firstPid ?? 1001) - 1;
  const leaders = new Map<number, string>();
  const groups = new Set<number>();
  const signals: string[] = [];
  const environments: Record<string, string>[] = [];
  const runner: SidecarProcessRunner = {
    spawn: ({ env }) => {
      environments.push(env);
      const pid = ++nextPid;
      leaders.set(pid, `started-${pid}`);
      groups.add(pid);
      return { pid, startedAt: `started-${pid}` };
    },
    startedAt: (pid) => leaders.get(pid) ?? null,
    groupAlive: (pid) => groups.has(pid),
    signal: (pid, signal) => {
      signals.push(`${signal}:${pid}`);
      if (options.unstoppable) return;
      if (signal === "SIGTERM" && options.ignoresTerm) return;
      leaders.delete(pid);
      if (signal === "SIGKILL" || !options.childrenOutliveTerm) groups.delete(pid);
    },
  };
  return { runner, leaders, groups, signals, environments };
}

const SIDECAR_KEY = "e".repeat(64);

let dataDir: string;
let groups: Set<number>;
let provisioner: SidecarProvisioner;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "process-provisioner-"));
  const fake = fakeRunner();
  groups = fake.groups;
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
    sidecarCredentialKeyHex: SIDECAR_KEY,
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
    expect(groups.size).toBe(0);
    expect(await ensure(2, "sc_new")).toMatchObject({ kind: "accepted" });
    expect(groups.size).toBe(1);
    expect((await readFile(join(dataDir, "allocations/sal_a/gen-2/sidecar.id"), "utf8")).trim()).toBe("sc_new");
  });

  test("replaces a unit a previous host left behind", async () => {
    await ensure(1, "sc_old");
    const fresh = fakeRunner();
    provisioner = create(fresh.runner);
    expect(await destroy(2, "sc_old")).toEqual({ kind: "destroyed" });
    expect(await ensure(2, "sc_new")).toMatchObject({ kind: "accepted" });
    expect(fresh.groups.size).toBe(1);
  });

  test("reuses the live process for a repeated ensure", async () => {
    const first = await ensure(1, "sc_a");
    expect(await ensure(1, "sc_a")).toEqual(first);
    expect(groups.size).toBe(1);
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
    expect(groups.size).toBe(1);
  });

  test("refuses a second identity for a generation that is already running", async () => {
    await ensure(1, "sc_a");
    expect(await ensure(1, "sc_b")).toMatchObject({ kind: "rejected", code: "sidecar_identity_conflict" });
  });

  test("keeps the binding fingerprint allocations were bound under", () => {
    expect(provisioner.bindingFingerprint).toBe("process:v1:deployment");
  });

  test("hands the sidecar its own key, and nothing the host's environment holds under that name", async () => {
    // The host's environment carrying a key is the leak this guards against,
    // whichever name it is under; neither may reach a sidecar.
    const canaries = {
      CREDENTIAL_ENCRYPTION_KEY: "hub-key-in-host-env",
      SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "hub-key-under-the-sidecar-name",
    };
    const previous = Object.fromEntries(Object.keys(canaries).map((name) => [name, process.env[name]]));
    Object.assign(process.env, canaries);
    try {
      const fake = fakeRunner();
      provisioner = create(fake.runner);
      await ensure(1, "sc_a");
      const env = fake.environments[0]!;
      expect(env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]).toBe(SIDECAR_KEY);
      for (const leaked of Object.values(canaries)) expect(Object.values(env)).not.toContain(leaked);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("kills the children a sidecar leaves behind before removing its unit", async () => {
    const fake = fakeRunner({ childrenOutliveTerm: true });
    provisioner = create(fake.runner);
    await ensure(1, "sc_a");
    expect(await destroy(2, "sc_a")).toEqual({ kind: "destroyed" });
    expect(fake.signals).toEqual(["SIGTERM:1001", "SIGKILL:1001"]);
    expect(fake.groups.size).toBe(0);
  });

  test("fails the destroy, and keeps the unit, while the group is still alive after SIGKILL", async () => {
    const fake = fakeRunner({ unstoppable: true });
    provisioner = create(fake.runner);
    await ensure(1, "sc_a");
    await expect(destroy(2, "sc_a")).rejects.toThrow("process group 1001 is still alive after SIGKILL");
    expect(fake.signals).toEqual(["SIGTERM:1001", "SIGKILL:1001"]);
    expect((await readFile(join(dataDir, "allocations/sal_a/gen-1/sidecar.pid"), "utf8")).trim()).toBe("1001");
  });

  test("never signals, or waits on, a process that reused a stale pid", async () => {
    await ensure(1, "sc_a");
    // The host comes back after a crash or a reboot, and pid 1001 now
    // belongs to something that started at another time.
    const later = fakeRunner({ firstPid: 2001 });
    later.leaders.set(1001, "started-elsewhere");
    later.groups.add(1001);
    provisioner = create(later.runner);

    expect(await destroy(2, "sc_a")).toEqual({ kind: "destroyed" });
    expect(later.signals).toEqual([]);
    expect(later.groups.has(1001)).toBe(true);
  });

  test("replaces, rather than reuses, a unit whose pid now belongs to another process", async () => {
    await ensure(1, "sc_a");
    const later = fakeRunner({ firstPid: 2001 });
    later.leaders.set(1001, "started-elsewhere");
    later.groups.add(1001);
    provisioner = create(later.runner);

    expect(await ensure(1, "sc_a")).toMatchObject({ kind: "accepted", externalRef: "sal_a:1:2001" });
    expect(later.signals).toEqual([]);
    expect((await readFile(join(dataDir, "allocations/sal_a/gen-1/sidecar.start"), "utf8")).trim()).toBe("started-2001");
  });

  test("a destroyed generation leaves none of its process tree running", async () => {
    // A sidecar that ignores SIGTERM and has a child of its own that does the
    // same, as a sidecar has its workflow processes.
    const entry = join(dataDir, "sidecar.ts");
    await writeFile(
      entry,
      [
        'process.on("SIGTERM", () => {});',
        'const child = Bun.spawn([process.execPath, "-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);\'], { stdin: "ignore" });',
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
      sidecarCredentialKeyHex: SIDECAR_KEY,
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

    try {
      const recorded = (await readFile(join(dataDir, "allocations/sal_a/gen-1/sidecar.start"), "utf8")).trim();
      expect(recorded).toBe(processStartedAt(sidecarPid)!);

      expect(await destroy(2, "sc_old")).toEqual({ kind: "destroyed" });
      expect(isRunning(sidecarPid)).toBe(false);
      expect(isRunning(childPid)).toBe(false);
    } finally {
      for (const pid of [sidecarPid, childPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, as it should be.
        }
      }
    }
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
