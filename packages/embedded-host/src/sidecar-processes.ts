/**
 * Spawned sidecars are child processes of this host, recorded by the process
 * provisioner as `<allocations>/<allocation>/gen-<n>/sidecar.pid`. They outlive
 * a host that exits without stopping them and then dial a hub that is gone,
 * forever. Stopping the host stops them; a smoke does the same on teardown.
 *
 * Only those two directory levels are read (#146). An allocation directory
 * also holds the sidecar's materialised closure, `node_modules` and all, and
 * a recursive walk over every allocation a workspace has ever had ran for
 * longer than the 10 s `dev:stop` allows before it kills the host outright,
 * so the database close that follows this never ran.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const PROVISIONER_DIRS = ["process-provisioner", "process-provisioner-probe"];
const PID_FILE = "sidecar.pid";
const GENERATION = /^gen-\d+$/;

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Every pid file the provisioner has written, at the depth it writes them. */
export async function sidecarPidFiles(hubDataDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const dir of PROVISIONER_DIRS) {
    const allocations = join(hubDataDir, dir, "allocations");
    for (const allocation of await subdirectories(allocations)) {
      for (const generation of await subdirectories(join(allocations, allocation))) {
        if (!GENERATION.test(generation)) continue;
        const entries = await readdir(join(allocations, allocation, generation)).catch(() => [] as string[]);
        if (entries.includes(PID_FILE)) files.push(join(allocations, allocation, generation, PID_FILE));
      }
    }
  }
  return files;
}

export async function stopSpawnedSidecars(
  hubDataDir: string,
  // A sidecar leads its own process group, so its workflow processes stop with it.
  signal: (pid: number) => void = (pid) => process.kill(-pid, "SIGTERM"),
): Promise<number> {
  let stopped = 0;
  for (const file of await sidecarPidFiles(hubDataDir)) {
    const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      signal(pid);
      stopped += 1;
    } catch {
      // Already gone.
    }
  }
  return stopped;
}
