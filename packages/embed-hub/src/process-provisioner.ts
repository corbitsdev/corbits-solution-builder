/**
 * Runs each sidecar allocation as a child process of this host, to the
 * `SidecarProvisioner` contract in `@intx/hub-sessions`.
 *
 * A replacement destroys the old identity at the new generation and then
 * ensures a new sidecarId at that same generation, so fences are per
 * (generation, sidecarId), as in Interchange's own local-process reference
 * provisioner. Keying fences by allocation alone fails every replacement.
 *
 * Units live at `<dataDir>/allocations/<allocation>/gen-<n>/` holding
 * `sidecar.pid`, `sidecar.id` and the sidecar's `data/`. That layout is what
 * `stopSpawnedSidecars` reads, and it is the only state: the hub's allocation
 * store is the authority, so the process tree on disk only has to be found
 * again after a restart, not re-derived.
 */
import { writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import type { SidecarCapabilityDeclaration } from "@intx/types";

export const PROCESS_PROVISIONER_ID = "process";

/**
 * Interchange adopts a probe's allocation for the deployment when the two
 * provisioners share id, api version and binding fingerprint, and that adopt
 * path does not deploy the workflow; the probe instance's fingerprint differs.
 */
export type ProcessProvisionerRole = "deployment" | "probe";

export interface SidecarProcessRunner {
  spawn(args: { command: readonly string[]; cwd: string; env: Record<string, string> }): number;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

export type ProcessProvisionerOptions = {
  readonly role: ProcessProvisionerRole;
  readonly dataDir: string;
  readonly runtimePath: string;
  readonly sidecarEntryPath: string;
  readonly runner?: SidecarProcessRunner;
  readonly terminationGraceMs?: number;
};

const PID_FILE = "sidecar.pid";
const ID_FILE = "sidecar.id";
const UNIT_PREFIX = "gen-";
const ALLOCATION_ID = /^[A-Za-z0-9._-]+$/;
const KILL_WAIT_MS = 2_000;

const CAPABILITIES: readonly SidecarCapabilityDeclaration[] = [
  { capability: "runtime:sidecar", state: "available" },
  { capability: "isolation:process", state: "available" },
  { capability: "isolation:container", state: "blocked" },
  { capability: "isolation:vm", state: "blocked" },
];

type Unit = { generation: number; dir: string; pid: number | null; sidecarId: string | null };

export function createProcessProvisioner(options: ProcessProvisionerOptions): SidecarProvisioner {
  if (!process.env["PATH"]) throw new Error("the host has no PATH to forward; a sidecar cannot resolve its runtime");
  const runner = options.runner ?? bunRunner;
  const graceMs = options.terminationGraceMs ?? 5_000;
  const allocationsDir = join(options.dataDir, "allocations");
  // Newest generation seen and the identity last destroyed at it. Memory is
  // enough: a request older than this process died with the previous host.
  const fences = new Map<string, { generation: number; destroyedSidecarId: string | null }>();
  const queues = new Map<string, Promise<unknown>>();

  function serialize<T>(allocationId: string, run: () => Promise<T>): Promise<T> {
    const next = (queues.get(allocationId) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    queues.set(allocationId, settled);
    void settled.then(() => {
      if (queues.get(allocationId) === settled) queues.delete(allocationId);
    });
    return next;
  }

  function allocationDir(allocationId: string): string {
    if (!ALLOCATION_ID.test(allocationId)) throw new Error(`invalid allocation id ${JSON.stringify(allocationId)}`);
    return join(allocationsDir, allocationId);
  }

  async function units(allocationId: string): Promise<Unit[]> {
    const root = allocationDir(allocationId);
    const entries = await readdir(root).catch((error: unknown) => {
      if (errno(error) === "ENOENT") return [] as string[];
      throw error;
    });
    const found: Unit[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(UNIT_PREFIX)) continue;
      const generation = Number(entry.slice(UNIT_PREFIX.length));
      if (!Number.isInteger(generation) || generation < 0) continue;
      const dir = join(root, entry);
      const pid = Number((await readOptional(join(dir, PID_FILE)))?.trim());
      const sidecarId = (await readOptional(join(dir, ID_FILE)))?.trim() || null;
      found.push({ generation, dir, pid: Number.isInteger(pid) && pid > 0 ? pid : null, sidecarId });
    }
    return found;
  }

  async function exited(pid: number, withinMs: number): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (runner.isAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(50);
    }
    return true;
  }

  /** The unit's directory, and with it its pid file, goes only once its process has. */
  async function stop(unit: Unit): Promise<void> {
    if (unit.pid !== null && runner.isAlive(unit.pid)) {
      runner.signal(unit.pid, "SIGTERM");
      if (!(await exited(unit.pid, graceMs))) {
        runner.signal(unit.pid, "SIGKILL");
        if (!(await exited(unit.pid, KILL_WAIT_MS))) {
          throw new Error(`sidecar process ${unit.pid} is still alive after SIGKILL`);
        }
      }
    }
    await rm(unit.dir, { recursive: true, force: true });
  }

  function fence(allocationId: string, generation: number, destroyedSidecarId: string | null = null): void {
    const current = fences.get(allocationId);
    if (current !== undefined && current.generation > generation) return;
    fences.set(allocationId, {
      generation,
      destroyedSidecarId: destroyedSidecarId ?? (current?.generation === generation ? current.destroyedSidecarId : null),
    });
  }

  async function ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const existing = await units(request.allocationId);
    const known = fences.get(request.allocationId);
    const newest = Math.max(known?.generation ?? -1, ...existing.map((unit) => unit.generation));
    if (newest > request.generation) {
      return rejected("stale_generation", `Generation ${request.generation} is older than ${newest}`, false);
    }
    if (known?.generation === request.generation && known.destroyedSidecarId === request.sidecarId) {
      return rejected("generation_destroyed", `Generation ${request.generation} was already destroyed`, false);
    }
    const current = existing.find((unit) => unit.generation === request.generation);
    const currentAlive = current?.pid != null && runner.isAlive(current.pid);
    if (current !== undefined && currentAlive && current.sidecarId !== request.sidecarId) {
      return rejected(
        "sidecar_identity_conflict",
        `Generation ${request.generation} already belongs to another sidecar identity`,
        false,
      );
    }
    if (current !== undefined && currentAlive) {
      fence(request.allocationId, request.generation);
      return { kind: "accepted", externalRef: externalRef(request, current.pid!) };
    }
    for (const unit of existing) await stop(unit);

    const dir = join(allocationDir(request.allocationId), `${UNIT_PREFIX}${request.generation}`);
    const dataDir = join(dir, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, ID_FILE), `${request.sidecarId}\n`, { mode: 0o600 });
    request.signal?.throwIfAborted();
    let pid: number;
    try {
      pid = runner.spawn({
        command: [options.runtimePath, options.sidecarEntryPath],
        cwd: dirname(options.sidecarEntryPath),
        env: sidecarEnv(request, dataDir),
      });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      return rejected("sidecar_spawn_failed", error instanceof Error ? error.message : String(error), true);
    }
    try {
      // Synchronously, so no await separates a live process from its record:
      // a unit without a pid file cannot be stopped.
      writeFileSync(join(dir, PID_FILE), `${pid}\n`, { mode: 0o600 });
    } catch (error) {
      await stop({ generation: request.generation, dir, pid, sidecarId: request.sidecarId });
      throw error;
    }
    fence(request.allocationId, request.generation);
    return { kind: "accepted", externalRef: externalRef(request, pid) };
  }

  async function destroy(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    for (const unit of await units(request.allocationId)) {
      if (unit.generation > request.generation) continue;
      // A late destroy for a superseded identity must not stop the replacement
      // that already owns this generation.
      if (unit.generation === request.generation && unit.sidecarId !== null && unit.sidecarId !== request.sidecarId) {
        continue;
      }
      await stop(unit);
    }
    await rmdir(allocationDir(request.allocationId)).catch(() => undefined);
    fence(request.allocationId, request.generation, request.sidecarId);
    return { kind: "destroyed" };
  }

  return {
    id: PROCESS_PROVISIONER_ID,
    apiVersion: 1,
    // The entry path and hub URL are read from the current options at every
    // spawn, so they are not part of what an allocation is bound to. Binding
    // them stranded every allocation whenever the checkout moved or the port
    // changed; the hub releases a row bound under the old shape.
    bindingFingerprint: `process:v1:${options.role}`,
    capabilities: CAPABILITIES,
    ensure: (request) => serialize(request.allocationId, () => ensure(request)),
    destroy: (request) => serialize(request.allocationId, () => destroy(request)),
  };
}

/** The sidecar learns everything else over the wire; nothing else of the host's environment is inherited. */
function sidecarEnv(request: EnsureSidecarRequest, dataDir: string): Record<string, string> {
  const inherited = ["PATH", "HOME", "TMPDIR", "SIDECAR_CREDENTIAL_ENCRYPTION_KEY", "SIDECAR_ADAPTER_MANIFEST"];
  const env: Record<string, string> = {};
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return {
    ...env,
    SIDECAR_DATA_DIR: dataDir,
    HUB_WS_URL: request.hubWebSocketUrl,
    SIDECAR_ID: request.sidecarId,
    SIDECAR_TOKEN: request.token,
  };
}

function rejected(code: string, message: string, retryable: boolean): EnsureSidecarResult {
  return { kind: "rejected", code, message, retryable };
}

function externalRef(request: EnsureSidecarRequest, pid: number): string {
  return `${request.allocationId}:${request.generation}:${pid}`;
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

const bunRunner: SidecarProcessRunner = {
  spawn({ command, cwd, env }) {
    const child = Bun.spawn([...command], { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    // Sidecars are stopped by `stopSpawnedSidecars` from their pid files, not
    // by waiting on them here.
    child.unref();
    return child.pid;
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (errno(error) === "ESRCH") return false;
      if (errno(error) === "EPERM") return true;
      throw error;
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};
