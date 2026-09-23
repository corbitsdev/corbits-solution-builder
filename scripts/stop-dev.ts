/**
 * Stops every Solutions Builder process on this machine.
 *
 *   bun run dev:stop
 *
 * The dev launcher, a host run from source, the interface watcher, the
 * desktop shell in development and every sidecar, from whichever checkout
 * started them. Hosts are asked to stop first, since a stopping host takes
 * its own sidecars down; whatever is still alive after a grace period is
 * killed outright, sidecars included, because a sidecar that outlives its
 * host dials a hub that is gone, forever. Says what it stopped, and is a
 * no-op when nothing is running.
 */

export type SolutionsBuilderProcess = {
  readonly pid: number;
  readonly role: "launcher" | "host" | "watcher" | "shell" | "sidecar";
  readonly command: string;
};

/**
 * Which of ours a command line is, by what it runs and what it runs it
 * with: the executable is the first token and the script is a whole
 * argument, never a substring, so a shell whose command merely mentions
 * these paths (a grep, this script's own tests) is not one of them.
 */
function roleOf(command: string): SolutionsBuilderProcess["role"] | null {
  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const exe = tokens[0]!.slice(tokens[0]!.lastIndexOf("/") + 1);
  const runs = (script: string) => tokens.slice(1).some((token) => token === script || token.endsWith(`/${script}`));
  if (exe === "bun") {
    if (runs("scripts/dev.ts")) return "launcher";
    if (runs("apps/hub/src/server.ts")) return "host";
    if (runs("vendor/interchange/apps/sidecar/src/index.ts")) return "sidecar";
    return null;
  }
  if (exe === "bunx" && tokens.slice(1).some((token) => token.startsWith("@tauri-apps/cli")) && tokens.includes("dev")) return "shell";
  const second = tokens[1] ? tokens[1].slice(tokens[1].lastIndexOf("/") + 1) : "";
  if ((exe === "vite" || ((exe === "node" || exe === "bun") && second === "vite")) && runs("apps/web/vite.config.ts")) return "watcher";
  return null;
}

/** The Solutions Builder processes among `ps -axo pid,command` lines, in the order given; never this process or the shell that ran it. */
export function solutionsBuilderProcesses(psLines: readonly string[], own: { readonly pid: number; readonly ppid: number } = { pid: process.pid, ppid: process.ppid }): SolutionsBuilderProcess[] {
  const found: SolutionsBuilderProcess[] = [];
  for (const line of psLines) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === own.pid || pid === own.ppid) continue;
    const command = match[2]!.trim();
    const role = roleOf(command);
    if (role) found.push({ pid, role, command });
  }
  return found;
}

/** The order to stop in: hosts and their launchers first, so sidecars go with them; sidecars last, for what is left. */
export function stopOrder(processes: readonly SolutionsBuilderProcess[]): SolutionsBuilderProcess[] {
  const rank: Record<SolutionsBuilderProcess["role"], number> = { launcher: 0, shell: 1, host: 2, watcher: 3, sidecar: 4 };
  return [...processes].sort((a, b) => rank[a.role] - rank[b.role] || a.pid - b.pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

async function listProcesses(): Promise<string[]> {
  const ps = Bun.spawn(["ps", "-axo", "pid,command"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split("\n").slice(1);
}

if (import.meta.main) {
  const GRACE_MS = 10_000;
  const running = stopOrder(solutionsBuilderProcesses(await listProcesses()));
  if (running.length === 0) {
    console.log("No Solutions Builder host, launcher, watcher, shell or sidecar is running.");
    process.exit(0);
  }
  for (const entry of running) {
    if (signal(entry.pid, "SIGTERM")) console.log(`asked ${entry.role} ${String(entry.pid)} to stop`);
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline && running.some((entry) => alive(entry.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const stubborn = running.filter((entry) => alive(entry.pid));
  for (const entry of stubborn) {
    if (signal(entry.pid, "SIGKILL")) console.log(`killed ${entry.role} ${String(entry.pid)}, which did not stop within ${String(GRACE_MS / 1000)}s`);
  }
  // Sidecars a host spawned after the listing, or that it failed to reap.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const leftovers = stopOrder(solutionsBuilderProcesses(await listProcesses()));
  for (const entry of leftovers) {
    if (signal(entry.pid, "SIGKILL")) console.log(`killed ${entry.role} ${String(entry.pid)} that was still running`);
  }
  console.log(`Stopped ${String(running.length)} process(es)${leftovers.length > 0 ? ` and ${String(leftovers.length)} leftover(s)` : ""}.`);
}
