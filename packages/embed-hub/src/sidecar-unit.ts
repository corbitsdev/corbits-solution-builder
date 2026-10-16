/**
 * How a sidecar's process is found again, told apart from a stranger, and
 * stopped.
 *
 * The provisioner starts each sidecar as the leader of its own process group
 * and records `sidecar.pid` and `sidecar.start` in the unit directory. The
 * group is what gets signalled: the workflow processes a sidecar spawns share
 * it, so stopping the sidecar stops them too, and the group stays addressable
 * by the sidecar's pid until every member has exited.
 *
 * `sidecar.start` is the process's start time, which names one incarnation of
 * a pid. After a crash or a reboot a pid file can name a pid the system has
 * since handed to something else; its start time will not match, and the
 * record is treated as a process that is gone rather than one to signal or
 * wait on.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PID_FILE = "sidecar.pid";
export const START_FILE = "sidecar.start";

export type SidecarProcess = {
  readonly pid: number;
  /** As `processStartedAt` reports it; null for a unit written before start times were recorded. */
  readonly startedAt: string | null;
};

export type GroupSignal = "SIGTERM" | "SIGKILL";

/** What tells a live process from a recorded one; the provisioner's runner implements it, and tests fake it. */
export interface ProcessProbe {
  startedAt(pid: number): string | null;
  groupAlive(pid: number): boolean;
}

export async function readSidecarProcess(unitDir: string): Promise<SidecarProcess | null> {
  const pid = Number((await readOptional(join(unitDir, PID_FILE)))?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = (await readOptional(join(unitDir, START_FILE)))?.trim() || null;
  return { pid, startedAt };
}

/**
 * The live process's start time, or null when no process has this pid. In
 * UTC: the stamp is compared across host runs, and the host's time zone can
 * change between them.
 */
export function processStartedAt(pid: number): string | null {
  // The state comes first: a zombie -- exited, its parent yet to reap it --
  // still answers `ps` with its start time and `kill(pid, 0)` with success,
  // but no process runs at that pid (#898). Only the rest of the line is the
  // start time, kept as `ps` prints it: a single-digit day is padded with
  // two spaces, and `sidecar.start` files already hold it that way.
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, TZ: "UTC" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const line = ps.stdout.toString().trim();
  if (ps.exitCode !== 0 || line === "") return null;
  const state = line.slice(0, line.search(/\s|$/));
  if (state.startsWith("Z")) return null;
  const startedAt = line.slice(state.length).trim();
  return startedAt === "" ? null : startedAt;
}

/** Whether any process is left in the group led by pid. */
export function groupAlive(pid: number): boolean {
  return deliver(-pid, 0);
}

/** False when there was no group of ours to signal. */
export function signalGroup(pid: number, signal: GroupSignal): boolean {
  return deliver(-pid, signal);
}

export const liveProbe: ProcessProbe = { startedAt: processStartedAt, groupAlive };

/** Whether the sidecar this record was written for is still running: a process at its pid with the start time recorded. */
export function sidecarAlive(record: SidecarProcess, probe: ProcessProbe = liveProbe): boolean {
  return record.startedAt !== null && probe.startedAt(record.pid) === record.startedAt;
}

/**
 * Whether the group led by the record's pid is ours to signal and wait on:
 * the sidecar itself or, once it has exited, the children it left behind. A
 * pid is not reissued while it names a live group, so a group whose leader is
 * gone is still the one the record was written for.
 */
export function ownsGroup(record: SidecarProcess, probe: ProcessProbe = liveProbe): boolean {
  const startedAt = probe.startedAt(record.pid);
  if (startedAt !== null) return record.startedAt !== null && startedAt === record.startedAt;
  return probe.groupAlive(record.pid);
}

function deliver(group: number, signal: GroupSignal | 0): boolean {
  try {
    process.kill(group, signal);
    return true;
  } catch (error) {
    // EPERM is a group with another user's process in it: not ours, so not
    // ours to wait on either.
    if (errno(error) === "ESRCH" || errno(error) === "EPERM") return false;
    throw error;
  }
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (errno(error) === "ENOENT") return null;
    throw error;
  });
}

function errno(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
