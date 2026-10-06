/**
 * Bounded local build bridge.
 *
 * This is a temporary seam that exists to stabilise the local loop, and it is
 * declared as one. Its output can never be presented as install evidence,
 * gate approval or target capability verification.
 *
 * Record of what it actually is:
 *
 *   owner          Solution Builder host (this file)
 *   purpose        run one coding-agent attempt on the approved plan
 *   interface      one CLI's non-interactive form — `corbits exec` by
 *                  default; the worker is chosen in Settings (build-worker.ts)
 *   inputs         one prompt packet and a working directory; the packet
 *                  goes by stdin or by a file the worker is pointed at,
 *                  never as one argument (Linux caps one at 128 KiB)
 *   outputs        final text on stdout, and an exit status; while it runs,
 *                  its stdout and stderr as written, and — where the worker
 *                  has a lifecycle hook — its own report of each turn
 *   failure        non-zero exit, or the binary being absent. No timeout: a
 *                  build takes as long as it takes, and cancel is the control
 *   cancel         SIGTERM to the worker's whole process group, so what it
 *                  spawned ends with it, SIGKILL to what remains after a
 *                  grace; the exit status and signal are recorded as they
 *                  were. The attempt ends when the worker exits: a process
 *                  it left behind holding its pipes is ended, not waited for
 *   permissions    inherits the operator's own CLI configuration; the bridge
 *                  never passes --dangerously-skip-permissions or any other
 *                  permission-skipping flag
 *   environment    PATH, HOME, the locale and temp directory, and the
 *                  variables the worker names for its sign-in; never the
 *                  host's own environment, which holds the hub's secrets
 *   linkage        every attempt is one numbered directory under the
 *                  project's builds, with its prompt and outcome beside it
 *
 * What this bridge therefore does NOT report, because the interface does not
 * provide it: session identity, normalised live events, per-agent roster
 * accounting, approval channels, checkpoint resume, steering, or pause. Those
 * are absent here rather than synthesised from stdout — a fake control is
 * worse than a missing one, because a human would act on it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inheritedEnvironment } from "@solutions-builder/specialist-runtime/host-environment";
import { buildWorker, hostPlatform, installInstruction, type BuildWorker, type InstallInstruction } from "./build-worker.js";
import { followFile } from "./file-follow.js";
import { followTurnLog } from "./turn-reports.js";

export const BRIDGE_ID = "bounded-local-corbits-exec";

/** Exactly what this bridge can observe. The UI renders from this list. */
export const BRIDGE_CAPABILITIES = {
  promptSubmission: true,
  finalText: true,
  exitStatus: true,
  liveEvents: false,
  /** The process's own stdout and stderr, as written, in arrival order. Not events. */
  liveOutput: true,
  /** The worker's own report of each turn through its lifecycle hook, where it has one. */
  turnReports: true,
  sessionInspection: false,
  questionsAndApprovals: false,
  steering: false,
  interrupt: true,
  checkpointResume: false,
  perAgentRoster: false,
} as const;

export type BridgeOutcome = {
  readonly bridgeId: string;
  /** Which worker ran, or would have. */
  readonly worker: string;
  readonly command: string;
  readonly available: boolean;
  readonly exitStatus: number | null;
  /** The signal that ended the process, when one did: a cancel, or the OS. */
  readonly signal: string | null;
  readonly finalText: string;
  readonly stderrTail: string;
  readonly workspace: string;
  /** Where the worker's turn reports were appended, or null when the worker has no hook. */
  readonly turnLog: string | null;
  /** How many turns and tool calls the worker reported; null when it could not report. */
  readonly turns: number | null;
  readonly toolCalls: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  /**
   * Always null. The interface returns no resumable checkpoint, so no
   * `resume` control is offered.
   */
  readonly checkpointRef: null;
};

export type BridgeAvailability = {
  readonly available: boolean;
  readonly detail: string;
  readonly worker: BuildWorker;
  /** How to get the worker on this host; null when it is present. */
  readonly install: InstallInstruction | null;
};

/**
 * Whether the chosen worker's CLI is actually present. Asked on every
 * `/build/worker` read and every start, so the probe is awaited rather than
 * run synchronously: a synchronous spawn would hold the host's event loop
 * for as long as the worker took to answer.
 */
export async function bridgeAvailable(): Promise<BridgeAvailability> {
  const worker = await buildWorker();
  const probeCommand = [worker.command, ...worker.probe].join(" ");
  let probe: { exitCode: number | null; signalCode: string | null; stdout: string };
  try {
    const child = Bun.spawn([worker.command, ...worker.probe], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: inheritedEnvironment(worker.environment),
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    probe = { exitCode: child.signalCode ? null : exitCode, signalCode: child.signalCode, stdout };
  } catch (cause) {
    // Absent is the commonest way to be unavailable, and it surfaces as a
    // spawn failure rather than an exit status.
    const code = (cause as { code?: string }).code;
    return {
      available: false,
      worker,
      install: installInstruction(worker, hostPlatform()),
      detail:
        code === "ENOENT"
          ? `${worker.label} (\`${worker.command}\`) is not installed, or not on this host's PATH. The build lane is unavailable.`
          : `${worker.label} (\`${worker.command}\`) could not be started (${code ?? String(cause)}). The build lane is unavailable.`,
    };
  }
  if (probe.signalCode) {
    // Killed before it could answer. On macOS that is what an invalid code
    // signature looks like; said plainly, since "exited null" reads as the
    // worker's own doing.
    return {
      available: false,
      worker,
      install: null,
      detail: `\`${probeCommand}\` was killed on launch (${probe.signalCode}), which is what an invalid code signature looks like on macOS. The build lane is unavailable.`,
    };
  }
  if (probe.exitCode !== 0) {
    return {
      available: false,
      worker,
      install: null,
      detail: `\`${probeCommand}\` exited ${String(probe.exitCode)}. The build lane is unavailable.`,
    };
  }
  const answer = probe.stdout;
  if (worker.probeExpects !== null && !answer.includes(worker.probeExpects)) {
    return {
      available: false,
      worker,
      install: null,
      detail: `The installed ${worker.label} does not advertise an \`${worker.probeExpects}\` verb; this bridge cannot drive it.`,
    };
  }
  return { available: true, worker, install: null, detail: `${worker.label} (\`${worker.command}\`) is available.` };
}

/**
 * Directories a continued attempt does not carry over: installed
 * dependencies and build caches are reproduced by the worker, and the hook
 * the bridge placed is written afresh for the new attempt. `.git` is kept —
 * the earlier attempt's commits are part of what is continued from.
 */
export const CONTINUE_EXCLUDES: ReadonlySet<string> = new Set([
  ".corbits",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  ".cache",
  ".turbo",
  ".next",
  "coverage",
]);

/** What one attempt is run with. */
export type RunBuildAttemptArgs = {
  workspace: string;
  prompt: string;
  /** Where the worker's turn reports go, beside the workspace, not in it. */
  turnLog: string;
  signal?: AbortSignal;
  /**
   * Where the worker's own output and exit status go, as files beside the
   * workspace (#783). With these, nothing the worker writes goes through a
   * pipe this host holds: a host that stops can leave the worker running
   * (`release`), and a host that starts can follow it again from the
   * files. Without them, or on Windows, the pipes are read here and the
   * worker cannot outlive the host.
   */
  record?: { readonly stdout: string; readonly stderr: string; readonly exit: string };
  /**
   * Fires when the host is stopping and the worker is to run on without
   * it: the bridge stops following and resolves null, with the worker
   * still there. Honoured only with `record`; a piped worker ends with
   * the host, so a release of one is ignored and its exit is awaited.
   */
  release?: AbortSignal;
  /**
   * An earlier attempt whose workspace is copied into this one before the
   * worker starts, so it continues from that work rather than from nothing.
   * Each attempt keeps its own directory: evidence is per attempt.
   */
  continueFrom?: string;
  /**
   * Each chunk the process writes, on either pipe, as it arrives, and each
   * turn the worker reports through its hook, said in a line or two. The
   * pipes pass through as text and nothing more: no lines are parsed, no
   * progress is inferred. A turn report is the worker's own.
   */
  onOutput?: (chunk: string, channel: "stdout" | "stderr" | "turn") => void;
  /**
   * The worker's pid and the process group it leads (null on Windows, which
   * has none), once it is up: what a host that restarts needs to know
   * whether the worker is still there, and what to signal if it is.
   */
  onStarted?: (process: { pid: number; pgid: number | null; worker: string; command: string }) => void;
};

/**
 * Runs one build attempt in `workspace`. Resolves with the outcome whether
 * the attempt succeeded or failed — a failed build is evidence, not an
 * exception — or with null when the worker was released to run on.
 */
export function runBuildAttempt(args: RunBuildAttemptArgs & { readonly release: AbortSignal }): Promise<BridgeOutcome | null>;
export function runBuildAttempt(args: RunBuildAttemptArgs): Promise<BridgeOutcome>;
export async function runBuildAttempt(args: RunBuildAttemptArgs): Promise<BridgeOutcome | null> {
  const startedAt = new Date().toISOString();
  const workspace = args.workspace;
  await mkdir(workspace, { recursive: true });
  if (args.continueFrom) {
    const from = args.continueFrom;
    await cp(from, workspace, {
      recursive: true,
      filter: (source) => !CONTINUE_EXCLUDES.has(source.slice(from.length + 1).split("/")[0] ?? ""),
    });
  }
  const availability = await bridgeAvailable();

  if (!availability.available) {
    return {
      bridgeId: BRIDGE_ID,
      worker: availability.worker.id,
      command: availability.worker.command,
      available: false,
      exitStatus: null,
      signal: null,
      finalText: "",
      stderrTail: availability.detail,
      workspace,
      turnLog: null,
      turns: null,
      toolCalls: null,
      startedAt,
      endedAt: new Date().toISOString(),
      checkpointRef: null,
    };
  }

  const worker = availability.worker;

  // A worker with a lifecycle hook is given one for this attempt, in its
  // working directory, and the log it appends to is followed while it runs.
  const turnLog = worker.turnReports ? args.turnLog : null;
  if (turnLog && worker.turnReports) {
    await writeFile(turnLog, "");
    for (const file of worker.turnReports.install(turnLog)) {
      const path = join(workspace, file.path);
      await mkdir(dirname(path), { recursive: true });
      // Executable: a CLI that runs its hooks directly, not through a shell, needs the bit.
      await writeFile(path, file.content, { mode: 0o755 });
    }
  }
  const following = turnLog ? followTurnLog(turnLog, (text) => args.onOutput?.(text, "turn")) : null;

  // The worker leads its own process group, so a cancel reaches the shells,
  // package managers and dev servers it spawned and not only the worker
  // itself; a plain kill of the parent leaves those running in the attempt
  // directory, still writing to it. On Windows there are no groups: the
  // tree is taken down by pid instead.
  if (worker.prompt.via === "file") {
    const path = join(workspace, worker.prompt.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.prompt);
    // Ignored by git beside it, so a worker's `git add -A` never commits the packet.
    await writeFile(join(dirname(path), ".gitignore"), `${basename(path)}\n`);
  }
  // The host's own environment carries the hub's secrets; the worker gets
  // what it needs to run and sign in, and nothing else.
  const environment = inheritedEnvironment(worker.environment);
  const recorded = args.record && process.platform !== "win32" ? args.record : null;
  if (recorded) await Promise.all([writeFile(recorded.stdout, ""), writeFile(recorded.stderr, ""), rm(recorded.exit, { force: true })]);
  const child = recorded
    ? spawn("/bin/sh", ["-c", RECORDING_SHELL, worker.command, ...worker.prompt.args], {
        cwd: workspace,
        stdio: [worker.prompt.via === "stdin" ? "pipe" : "ignore", "ignore", "ignore"],
        env: { ...environment, [RECORD_STDOUT]: recorded.stdout, [RECORD_STDERR]: recorded.stderr, [RECORD_EXIT]: recorded.exit },
        detached: true,
      })
    : spawn(worker.command, [...worker.prompt.args], {
        cwd: workspace,
        stdio: [worker.prompt.via === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
        env: environment,
        detached: process.platform !== "win32",
      });
  if (child.pid !== undefined) {
    args.onStarted?.({ pid: child.pid, pgid: process.platform === "win32" ? null : child.pid, worker: worker.id, command: worker.command });
  }
  if (worker.prompt.via === "stdin" && child.stdin) {
    // A worker that dies before reading gets EPIPE here; its exit is the record.
    child.stdin.on("error", () => undefined);
    child.stdin.end(args.prompt);
  }
  const ended = new Promise<{ exitStatus: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ exitStatus: code, signal }));
    // A spawn failure after the probe passed (the binary vanished, a
    // permissions change) surfaces as an error event with no exit.
    child.once("error", (cause) => {
      args.onOutput?.(`${worker.label} could not be started: ${cause.message}\n`, "stderr");
      resolve({ exitStatus: null, signal: null });
    });
  });

  // A cancel can land before the process is up; an already-aborted signal
  // never fires its listener, so it is checked as well as listened for.
  if (args.signal?.aborted) killTree(child);
  args.signal?.addEventListener("abort", () => killTree(child), { once: true });

  // Recorded: the files are followed the way the turn log is. Piped: the
  // pipes are drained here.
  const followers = recorded
    ? [followFile(recorded.stdout, (chunk) => args.onOutput?.(chunk, "stdout")), followFile(recorded.stderr, (chunk) => args.onOutput?.(chunk, "stderr"))]
    : [];
  const draining = recorded
    ? null
    : Promise.all([drain(child.stdout, (chunk) => args.onOutput?.(chunk, "stdout")), drain(child.stderr, (chunk) => args.onOutput?.(chunk, "stderr"))]);

  // A release while the worker runs: stop following, let go of the
  // process, and say nothing of an outcome. The files go on filling.
  const released = new Promise<"released">((resolve) => {
    if (!recorded || !args.release) return;
    if (args.release.aborted) resolve("released");
    args.release.addEventListener("abort", () => resolve("released"), { once: true });
  });
  const result = await Promise.race([ended, released]);
  if (result === "released") {
    child.unref();
    await Promise.all([...followers.map((follower) => follower.stop()), following?.stop()]);
    return null;
  }
  const { exitStatus, signal } = result;

  // The attempt ends when the worker exits, and nothing that outlives the
  // worker belongs to the attempt: a dev server it backgrounded would keep
  // writing into the directory that is about to be packaged. The pipes get
  // a short grace to close (a child that inherited them holds them open),
  // then the group is ended whether or not anything held a pipe — a child
  // with its output redirected holds none and is just as much there.
  const drained = draining ? await Promise.race([draining.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), PIPE_GRACE_MS).unref())]) : true;
  if (child.pid !== undefined && groupAlive(child.pid)) {
    args.onOutput?.(`${worker.label} exited but left processes running in its group; they were ended.\n`, "stderr");
  }
  killTree(child);
  if (!drained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const [stdout, stderr] = draining ? await draining : await recordedOutput(recorded!);
  await Promise.all(followers.map((follower) => follower.stop()));
  const tally = following ? await following.stop() : null;

  return {
    bridgeId: BRIDGE_ID,
    worker: worker.id,
    command: worker.command,
    available: true,
    exitStatus,
    signal,
    // Final text as the process emitted it. No parsing into synthetic events.
    finalText: stdout,
    stderrTail: stderrTail(stderr),
    workspace,
    turnLog,
    turns: tally?.turns ?? null,
    toolCalls: tally?.toolCalls ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    checkpointRef: null,
  };
}

/** How long the worker's tree gets to end on SIGTERM before SIGKILL. */
export const CANCEL_GRACE_MS = 3_000;

/** Enough of a long build's final text to read; the file beside the attempt has it all. */
export const FINAL_TEXT_KEEP = 200_000;

const RECORD_STDOUT = "SOLUTIONS_BUILDER_RECORD_STDOUT";
const RECORD_STDERR = "SOLUTIONS_BUILDER_RECORD_STDERR";
const RECORD_EXIT = "SOLUTIONS_BUILDER_RECORD_EXIT";

/**
 * The shell that stands between the host and a recorded worker (#783). It
 * runs the worker with its output appended to the record files and the
 * host's stdin passed through, waits for it, and writes its exit status
 * to the exit file; so the status is on disk even when the host that
 * started the worker is gone by the time it ends. A SIGTERM to the group
 * reaches the worker directly; the trap passes it on as well and keeps
 * the shell itself alive to record the exit. `$0` is the worker's
 * command, `$@` its arguments.
 */
export const RECORDING_SHELL = [
  `exec 3<&0`,
  `"$0" "$@" <&3 >>"$${RECORD_STDOUT}" 2>>"$${RECORD_STDERR}" &`,
  `child=$!`,
  `exec 3<&-`,
  `trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP`,
  `wait "$child"`,
  `status=$?`,
  `while kill -0 "$child" 2>/dev/null; do wait "$child"; status=$?; done`,
  `printf '%s\\n' "$status" >"$${RECORD_EXIT}"`,
  `exit "$status"`,
].join("\n");

/** The last 40 lines, which is what the record keeps of stderr. */
export function stderrTail(stderr: string): string {
  return stderr.split("\n").slice(-40).join("\n");
}

/** What a recorded worker wrote: the tail of its stdout, and its stderr. */
export async function recordedOutput(record: { readonly stdout: string; readonly stderr: string }): Promise<[string, string]> {
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  const [stdout, stderr] = await Promise.all([read(record.stdout), read(record.stderr)]);
  return [stdout.slice(-FINAL_TEXT_KEEP), stderr];
}

/** The exit status a recorded worker left, or null when it left none (killed outright, or still running). */
export async function recordedExit(path: string): Promise<number | null> {
  try {
    const status = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(status) ? status : null;
  } catch {
    return null;
  }
}

/** How long the pipes get to close after the worker itself has exited. */
export const PIPE_GRACE_MS = 1_500;

/** Whether any process in the group `pgid` leads is still there. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends the worker and everything it started: SIGTERM to the group it
 * leads, then SIGKILL to whatever is still there after the grace. The
 * second is not politeness failing — a child that was started with
 * SIGTERM ignored (a shell's inherited disposition) never sees the first,
 * and would keep the attempt's pipes, and its directory, in use.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  killGroup(child.pid, (signal) => child.exitCode === null && child.signalCode === null && child.kill(signal));
}

/**
 * Signals the group `pgid` leads, SIGTERM then SIGKILL after the grace;
 * `fallback` is tried with the same signal when the group is already gone
 * (the leader alone, when it is still known). The group is signalled
 * whether or not its leader has exited: the leader exiting is exactly the
 * case in which what it left behind must be reached.
 */
export function killGroup(pgid: number, fallback: (signal: NodeJS.Signals) => unknown = () => undefined): void {
  const pid = pgid;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).once("error", () => fallback("SIGKILL"));
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      // Negative pid: the whole group the worker leads (`detached` above).
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) fallback("SIGTERM");
  const timer = setTimeout(() => {
    if (!signalGroup("SIGKILL")) fallback("SIGKILL");
  }, CANCEL_GRACE_MS);
  // The group may linger past the worker's own exit; the timer stands
  // either way, and never keeps the host up by itself.
  timer.unref();
}

/** Reads a stream to its end, handing each chunk on as it lands, and returns the whole. */
async function drain(stream: NodeJS.ReadableStream | null, onChunk: (text: string) => void): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  const parts: string[] = [];
  try {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk as Uint8Array, { stream: true });
      if (text.length === 0) continue;
      parts.push(text);
      onChunk(text);
    }
  } catch {
    // Destroyed from this side once the worker exited and its group was
    // ended: what was read stands.
  }
  const rest = decoder.decode();
  if (rest.length > 0) {
    parts.push(rest);
    onChunk(rest);
  }
  return parts.join("");
}
