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
 *   interface      one CLI's non-interactive form — `corbits exec <prompt>`
 *                  by default; the worker is chosen in Settings (build-worker.ts)
 *   inputs         one prompt string and a working directory
 *   outputs        final text on stdout, and an exit status; while it runs,
 *                  its stdout and stderr as written, and — where the worker
 *                  has a lifecycle hook — its own report of each turn
 *   failure        non-zero exit, or the binary being absent. No timeout: a
 *                  build takes as long as it takes, and cancel is the control
 *   cancel         SIGTERM to the worker's whole process group, so what it
 *                  spawned ends with it; the exit status and signal are
 *                  recorded as they were
 *   permissions    inherits the operator's own CLI configuration; the bridge
 *                  never passes --dangerously-skip-permissions or any other
 *                  permission-skipping flag
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
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildWorker, hostPlatform, installInstruction, type BuildWorker, type InstallInstruction } from "./build-worker.js";
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

/** Whether the chosen worker's CLI is actually present. */
export async function bridgeAvailable(): Promise<BridgeAvailability> {
  const worker = await buildWorker();
  const probeCommand = [worker.command, ...worker.probe].join(" ");
  let probe: ReturnType<typeof Bun.spawnSync>;
  try {
    probe = Bun.spawnSync([worker.command, ...worker.probe], {
      stdout: "pipe",
      stderr: "pipe",
    });
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
      detail: `\`${probeCommand}\` exited ${probe.exitCode}. The build lane is unavailable.`,
    };
  }
  const answer = probe.stdout?.toString() ?? "";
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

/**
 * Runs one build attempt in `workspace`. Resolves with the outcome whether
 * the attempt succeeded or failed — a failed build is evidence, not an
 * exception.
 */
export async function runBuildAttempt(args: {
  workspace: string;
  prompt: string;
  /** Where the worker's turn reports go, beside the workspace, not in it. */
  turnLog: string;
  signal?: AbortSignal;
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
}): Promise<BridgeOutcome> {
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
      await writeFile(path, file.content);
    }
  }
  const following = turnLog ? followTurnLog(turnLog, (text) => args.onOutput?.(text, "turn")) : null;

  // The worker leads its own process group, so a cancel reaches the shells,
  // package managers and dev servers it spawned and not only the worker
  // itself; a plain kill of the parent leaves those running in the attempt
  // directory, still writing to it. On Windows there are no groups: the
  // tree is taken down by pid instead.
  const child = spawn(worker.command, [...worker.run(args.prompt)], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: process.platform !== "win32",
  });
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

  const [stdout, stderr] = await Promise.all([
    drain(child.stdout, (chunk) => args.onOutput?.(chunk, "stdout")),
    drain(child.stderr, (chunk) => args.onOutput?.(chunk, "stderr")),
  ]);
  const { exitStatus, signal } = await ended;
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
    stderrTail: stderr.split("\n").slice(-40).join("\n"),
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

/**
 * Ends the worker and everything it started: SIGTERM to the group it
 * leads, then SIGKILL to whatever is still there after the grace. The
 * second is not politeness failing — a child that was started with
 * SIGTERM ignored (a shell's inherited disposition) never sees the first,
 * and would keep the attempt's pipes, and its directory, in use.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).once("error", () => child.kill());
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
  if (!signalGroup("SIGTERM")) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!signalGroup("SIGKILL")) child.kill("SIGKILL");
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
  for await (const chunk of stream) {
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    if (text.length === 0) continue;
    parts.push(text);
    onChunk(text);
  }
  const rest = decoder.decode();
  if (rest.length > 0) {
    parts.push(rest);
    onChunk(rest);
  }
  return parts.join("");
}
