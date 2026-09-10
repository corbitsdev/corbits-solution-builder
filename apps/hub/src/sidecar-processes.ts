/**
 * Spawned sidecars are child processes of this host, recorded by the process
 * provisioner as `<allocations>/<allocation>/gen-<n>/sidecar.pid`. They outlive
 * a host that exits without stopping them and then dial a hub that is gone,
 * forever. Stopping the host stops them; a smoke does the same on teardown.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const PROVISIONER_DIRS = ["process-provisioner", "process-provisioner-probe"];

export async function stopSpawnedSidecars(hubDataDir: string): Promise<number> {
  let stopped = 0;
  for (const dir of PROVISIONER_DIRS) {
    const allocations = join(hubDataDir, dir, "allocations");
    const units = await readdir(allocations, { recursive: true }).catch(() => [] as string[]);
    for (const entry of units) {
      if (!String(entry).endsWith("sidecar.pid")) continue;
      const pid = Number((await readFile(join(allocations, String(entry)), "utf8").catch(() => "")).trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, "SIGTERM");
        stopped += 1;
      } catch {
        // Already gone.
      }
    }
  }
  return stopped;
}
