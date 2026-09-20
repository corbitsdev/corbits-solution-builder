/**
 * Process-safety helpers for the deployed project-workflow proof.
 *
 * A proof scenario boots a real hub host, a process-provisioner sidecar,
 * and a workflow-child, all inside an isolated temp data dir, and it kills
 * some of them on purpose. Every kill target must be verified by identity
 * (pid + start time + command + parent + data dir) immediately before the
 * kill, because a bare pid is reused by the OS and is never authority on
 * its own. This mirrors the same discipline the earlier tracker proof used;
 * re-authored here rather than imported so this package owns its own proof
 * safety surface.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class ProofFailure extends Error {
  constructor(
    readonly category: "deadline" | "ownership" | "http" | "dependency" | "history",
    readonly status?: number,
  ) {
    super(category);
  }
}

export function safeFailure(error: unknown): { category: string; status?: number } {
  return error instanceof ProofFailure
    ? { category: error.category, ...(error.status === undefined ? {} : { status: error.status }) }
    : { category: "dependency" };
}

export function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProofFailure("deadline"));
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function request(input: string | URL | Request, init: RequestInit = {}, scenario?: AbortSignal): Promise<Response> {
  const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(scenario ? [scenario] : []), ...(init.signal ? [init.signal] : [])]);
  const response = await bounded(fetch(input, { ...init, signal }), signal);
  const bytes = await bounded(response.arrayBuffer(), signal);
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export type ProcessIdentity = { pid: number; parent: number; start: string; command: string };

export function inspectProcess(pid: number): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 1) throw new ProofFailure("ownership");
  const query = (column: string) => {
    const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", `${column}=`], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2000 });
    if (result.exitCode !== 0) throw new ProofFailure("ownership");
    return result.stdout.toString().trim();
  };
  const start = query("lstart");
  const command = query("command");
  if (!start || !command) throw new ProofFailure("ownership");
  return { pid, parent: Number(query("ppid")), start, command };
}

export type Receipt = ProcessIdentity & { entry: string; executable: string; data: string | null; isolated: boolean };

const CREDENTIAL_SENTINELS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SOLUTIONS_BUILDER_HUB_URL"] as const;

export async function recordProcess(root: string): Promise<void> {
  const live = inspectProcess(process.pid);
  const receipt: Receipt = {
    ...live,
    entry: process.argv[1] ?? "",
    executable: process.execPath,
    data: process.env.SIDECAR_DATA_DIR ?? null,
    isolated: CREDENTIAL_SENTINELS.every((key) => process.env[key] === undefined),
  };
  await writeFile(join(root, "receipts", `${process.pid}.json`), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  if (!receipt.isolated) throw new ProofFailure("ownership");
}

export function verifyIdentity(receipt: Receipt, live: ProcessIdentity, expected: { entry: string; data?: string; parent?: number }): void {
  if (
    !receipt.isolated ||
    receipt.pid !== live.pid ||
    receipt.start !== live.start ||
    receipt.command !== live.command ||
    receipt.entry !== expected.entry ||
    !live.command.split(/\s+/).includes(expected.entry) ||
    !live.command.split(/\s+/).includes(receipt.executable) ||
    (expected.data !== undefined && receipt.data !== expected.data) ||
    (expected.parent !== undefined && (receipt.parent !== expected.parent || live.parent !== expected.parent))
  ) {
    throw new ProofFailure("ownership");
  }
}

export async function receiptFor(root: string, pid: number): Promise<Receipt> {
  const value: unknown = JSON.parse(await readFile(join(root, "receipts", `${pid}.json`), "utf8"));
  if (
    typeof value !== "object" || value === null ||
    !("pid" in value) || typeof value.pid !== "number" ||
    !("parent" in value) || typeof value.parent !== "number" ||
    !("start" in value) || typeof value.start !== "string" ||
    !("command" in value) || typeof value.command !== "string" ||
    !("entry" in value) || typeof value.entry !== "string" ||
    !("executable" in value) || typeof value.executable !== "string" ||
    !("data" in value) || (value.data !== null && typeof value.data !== "string") ||
    !("isolated" in value) || typeof value.isolated !== "boolean"
  ) {
    throw new ProofFailure("ownership");
  }
  return {
    pid: value.pid, parent: value.parent, start: value.start, command: value.command,
    entry: value.entry, executable: value.executable, data: value.data, isolated: value.isolated,
  };
}

export async function isolatedLaunch(root: string): Promise<{ executable: string; args: string[]; env: Record<string, string> }> {
  const executable = process.execPath;
  if (/[\s'\n]/.test(executable + root)) throw new ProofFailure("ownership");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "receipts"), { recursive: true });
  const preload = join(root, "receipt-preload.ts");
  await writeFile(
    preload,
    `import { recordProcess } from ${JSON.stringify(join(import.meta.dir, "project-workflow-proof-safety.ts"))}; await recordProcess(${JSON.stringify(root)});\n`,
    { mode: 0o600 },
  );
  await writeFile(join(bin, "bun"), `#!/bin/sh\nexec '${executable}' --no-env-file --preload '${preload}' "$@"\n`, { mode: 0o700 });
  return {
    executable,
    args: ["--no-env-file", "--preload", preload],
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: root,
      TMPDIR: root,
      SOLUTIONS_BUILDER_DATA_DIR: root,
      SOLUTIONS_BUILDER_SMOKE: "1",
      SOLUTIONS_BUILDER_CREDENTIAL_BACKEND: "file",
    },
  };
}

export function terminalRetry(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 409 && "code" in error && error.code === "workflow_run_not_running";
}

export function allocationIdentity(snapshot: unknown, deployment: string): { id: string; generation: number } {
  if (typeof snapshot !== "object" || snapshot === null || !("allocations" in snapshot) || !Array.isArray(snapshot.allocations)) {
    throw new ProofFailure("ownership");
  }
  const rows = snapshot.allocations.filter(
    (row: unknown) => typeof row === "object" && row !== null && "anchor_run_id" in row && row.anchor_run_id === deployment,
  );
  const row = rows[0];
  if (rows.length !== 1 || typeof row.id !== "string" || !/^sal_[a-zA-Z0-9]+$/.test(row.id) || !Number.isInteger(row.generation) || row.generation < 1 || row.status !== "allocated") {
    throw new ProofFailure("ownership");
  }
  return { id: row.id, generation: row.generation };
}

export function proofDescendants(receipts: Receipt[], hosts: Set<number>, root: string, workerEntry: string, childEntries: string[]): Receipt[] {
  const workers = receipts.filter((receipt) =>
    hosts.has(receipt.parent) && receipt.entry === workerEntry && receipt.data !== null &&
    ["process-provisioner", "process-provisioner-probe"].some((role) => {
      const prefix = `${join(root, "hub", role, "allocations")}/`;
      return receipt.data!.startsWith(prefix) && /^[A-Za-z0-9_-]+\/gen-(0|[1-9][0-9]*)\/data$/.test(receipt.data!.slice(prefix.length));
    }),
  );
  const workerIds = new Set(workers.map((worker) => worker.pid));
  return [...receipts.filter((receipt) => workerIds.has(receipt.parent) && childEntries.includes(receipt.entry)), ...workers];
}

export async function cleanupDescendants(root: string, hosts: Set<number>, workerEntry: string, childEntries: string[]): Promise<void> {
  const receipts: Receipt[] = [];
  for (const filename of new Bun.Glob("*.json").scanSync(join(root, "receipts"))) {
    try {
      receipts.push(await receiptFor(root, Number(filename.slice(0, -5))));
    } catch {
      // Invalid receipt is not authority.
    }
  }
  for (const receipt of proofDescendants(receipts, hosts, root, workerEntry, childEntries)) {
    try {
      const live = inspectProcess(receipt.pid);
      if (live.parent !== receipt.parent && live.parent !== 1) continue;
      verifyIdentity(receipt, live, { entry: receipt.entry, ...(receipt.data === null ? {} : { data: receipt.data }) });
      process.kill(receipt.pid, "SIGKILL");
    } catch {
      // Refuse disappeared/reused pids.
    }
  }
}
