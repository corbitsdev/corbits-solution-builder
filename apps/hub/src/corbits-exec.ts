/**
 * Bounded local build bridge — BUILD_PLAN_V3 section 4.
 *
 * This is a temporary seam that exists to stabilise the local loop, and it is
 * declared as one. It is **not** the shared-hub multi-agent integration that
 * Gate 7 requires, and its output can never be presented as install evidence,
 * gate approval or target capability verification.
 *
 * Record of what it actually is, per section 4's "before use" requirement:
 *
 *   owner          Solutions Builder host (this file)
 *   purpose        stabilise freeze -> running -> evidence for the local loop
 *   interface      one CLI's non-interactive form — `corbits exec <prompt>`
 *                  by default; the worker is chosen in Settings (build-worker.ts)
 *   inputs         one prompt string, a working directory seeded with the
 *                  packet, a model/provider
 *   outputs        final text on stdout, and an exit status; while it runs,
 *                  its stdout and stderr as written, and — where the worker
 *                  has a lifecycle hook — its own report of each turn
 *   failure        non-zero exit, or the binary being absent. A turn is not
 *                  killed the moment it is slow — a worker mid-build should
 *                  not be cut off capriciously — but the attempt's
 *                  wall-clock budget is a deadline on the whole attempt, not
 *                  just the gaps between invocations: it bounds whichever
 *                  invocation is running when it expires, single turn or
 *                  not, because an unbounded invocation makes the budget a
 *                  fiction. The continuation loop below also carries a turn
 *                  budget across invocations, because unlike a single turn,
 *                  "no bound on how many turns a stalled worker gets" is not
 *                  a control worth having
 *   permissions    inherits the operator's own CLI configuration; the bridge
 *                  never passes --dangerously-skip-permissions
 *   linkage        every attempt is linked to an immutable packet and run
 *   exit criterion replaced by verified shared-hub integration before launch
 *
 * What this bridge therefore does NOT report, because the interface does not
 * provide it: session identity, normalised live events, per-agent roster
 * accounting, approval channels, checkpoint resume, steering, or pause. Those
 * are absent here rather than synthesised from stdout — a fake control is worse
 * than a missing one, because a human would act on it.
 *
 * A coding agent finishes a turn, reports, and waits for its next
 * instruction; `corbits exec` is one-shot, so the first return would end the
 * attempt wherever the model paused — typically well short of the plan. This
 * bridge re-invokes the worker instead of treating that return as final,
 * asking it to continue in the same workspace. `corbits resume`/`continue`
 * exists but is an interactive session picker with no non-interactive form
 * (verified against `corbits --help`), so a clean resume is not reachable
 * through this interface; re-invoking `exec` with a continuation prompt in
 * the same working directory is the reachable alternative.
 *
 * The loop's stop condition is never "this output looks done" guessed from
 * stdout — the interface gives no event for that, and guessing would be
 * exactly the synthesis this bridge refuses elsewhere. Instead, after each
 * invocation that changed the workspace, the deliverable's own checks are
 * run (`execution-checks.ts`: its declared `test`/`typecheck` scripts and its
 * entry point — the same checks `delivery.ts` runs at delivery time, reused
 * rather than reimplemented). All of them passing is `"complete"`: a
 * definition of done, not silence. A failing check's command, exit status
 * and output tail are folded into the next continuation's prompt, so the
 * worker is told what broke rather than only "continue". Checks are skipped
 * when a continuation changed nothing — an unchanged workspace cannot have
 * produced a new result — which is also why `"stalled"` now means something
 * narrow: no change AND no failing check to act on. The abort signal and the
 * turn/wall-clock budgets still apply on top of all of this, because a build
 * that never reaches passing checks must still terminate.
 *
 * This interface also gives no event for "the worker has a question" —
 * `BRIDGE_CAPABILITIES.questionsAndApprovals` is false, and nothing here
 * synthesises a question out of stdout. A human checkpoint belongs at the
 * call site that owns a real question/approval channel (the workflow-native
 * build), not invented here from a guess.
 */
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDirectory } from "./paths.js";
import { seedBuildWorkspace, type WorkspaceSeed } from "./build-workspace.js";
import { buildWorker, type BuildWorker } from "./build-worker.js";
import { followTurnLog } from "./turn-reports.js";
import { runExecutionChecks, type ExecutionCheck } from "./execution-checks.js";

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

/**
 * Why the continuation loop ended. Null when the worker never ran
 * (unavailable).
 *
 *   complete    the deliverable's own checks all passed. The definition of
 *               done — see the file header.
 *   stalled     the workspace did not change across `maxStaleContinuations`
 *               continuations AND there was no failing check to hand back —
 *               either no checks were discoverable at all, or (impossible to
 *               reach without also being "complete") every discovered check
 *               passed. Narrow, and expected to be rare: a failing check
 *               keeps the loop going even when the workspace is unchanged,
 *               because the worker has something concrete to act on.
 *   aborted     the caller's own signal fired.
 *   turn_budget `maxContinuations` was reached with checks still failing or
 *               undiscoverable.
 *   wall_clock_budget the attempt's wall-clock budget expired, mid-invocation
 *               or between them.
 */
export type ContinuationStopReason = "complete" | "stalled" | "aborted" | "turn_budget" | "wall_clock_budget";

/** Tunes the continuation loop; every field has a default. */
export type ContinuationConfig = {
  /** Consecutive continuations with no workspace change AND no failing check before giving up on progress. */
  readonly maxStaleContinuations?: number;
  /** Total continuations, regardless of progress, before the turn budget stops the loop. */
  readonly maxContinuations?: number;
  /** Wall-clock budget for the whole attempt, continuations included. */
  readonly maxWallClockMs?: number;
};

const DEFAULT_MAX_STALE_CONTINUATIONS = 2;
// Checks now feed the worker concrete failures instead of silence, so a
// continuation is more likely to be productive than before — but the budget
// still has to be a number, not "keep going": 16 gives roughly double the
// previous headroom (8) for a worker that is actually making progress
// against failing checks, while the wall-clock budget below remains the
// backstop for a worker that just burns turns.
const DEFAULT_MAX_CONTINUATIONS = 16;
const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

export type BridgeOutcome = {
  readonly bridgeId: string;
  /** Which worker ran, or would have. */
  readonly worker: string;
  readonly available: boolean;
  /** The last invocation's exit status: what ended the attempt, not what every continuation returned. */
  readonly exitStatus: number | null;
  /** Every invocation's stdout, in order, joined by a blank line — one attempt can be several invocations. */
  readonly finalText: string;
  /** The tail of every invocation's stderr, in order. */
  readonly stderrTail: string;
  readonly workspace: string;
  /** Where the worker's turn reports were appended, or null when the worker has no hook. */
  readonly turnLog: string | null;
  /** How many turns and tool calls the worker reported; null when it could not report. */
  readonly turns: number | null;
  readonly toolCalls: number | null;
  /** The earlier attempt whose workspace this one started from, or null for a clean start. */
  readonly continuedFrom: string | null;
  /** How many times the worker was re-invoked after its first return. 0 means it ran once. */
  readonly continuations: number;
  /** Why the loop stopped. Null when the worker never ran. See `ContinuationStopReason`. */
  readonly stopReason: ContinuationStopReason | null;
  /**
   * The last execution checks run against the workspace — null when the
   * worker never ran, empty when no check was discoverable (no entry point,
   * no declared `test`/`typecheck` script). Not re-run after a continuation
   * that changed nothing, so this can be older than the final invocation.
   */
  readonly execution: ExecutionCheck[] | null;
  readonly startedAt: string;
  readonly endedAt: string;
  /**
   * Always null. The interface returns no resumable checkpoint, so the guard
   * refuses `build.resume` rather than offering a control that would fail.
   */
  readonly checkpointRef: null;
};

/** Whether the chosen worker's CLI is actually present. */
export async function bridgeAvailable(): Promise<{ available: boolean; detail: string; worker: BuildWorker }> {
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
      detail: `\`${probeCommand}\` was killed on launch (${probe.signalCode}), which is what an invalid code signature looks like on macOS. The build lane is unavailable.`,
    };
  }
  if (probe.exitCode !== 0) {
    return {
      available: false,
      worker,
      detail: `\`${probeCommand}\` exited ${probe.exitCode}. The build lane is unavailable.`,
    };
  }
  const answer = probe.stdout?.toString() ?? "";
  if (worker.probeExpects !== null && !answer.includes(worker.probeExpects)) {
    return {
      available: false,
      worker,
      detail: `The installed ${worker.label} does not advertise an \`${worker.probeExpects}\` verb; this bridge cannot drive it.`,
    };
  }
  return { available: true, worker, detail: `${worker.label} (\`${worker.command}\`) is available.` };
}

export async function workspaceFor(runId: string): Promise<string> {
  const path = join(dataDirectory(), "builds", runId);
  await mkdir(path, { recursive: true });
  return path;
}

/** Beside the workspace, not in it: the worker builds in one and reports into the other. */
export function turnLogFor(runId: string): string {
  return join(dataDirectory(), "builds", `${runId}.turns.jsonl`);
}

/**
 * Runs one build attempt. Resolves with the outcome whether the attempt
 * succeeded or failed — a failed build is evidence, not an exception.
 */
export async function runBuildAttempt(args: {
  runId: string;
  prompt: string;
  /**
   * What the workspace starts with. On a clean start the whole seed is
   * written; on a continued one only the `.corbits` packet files, over the
   * copied workspace, so a retry builds against this attempt's plan.
   */
  seed: WorkspaceSeed;
  signal?: AbortSignal;
  /**
   * An earlier attempt whose workspace is copied into this one before the
   * worker starts, so it continues from that work rather than from nothing.
   * Each attempt keeps its own directory: evidence is per attempt.
   */
  continueFrom?: { runId: string; workspace: string };
  /**
   * Each chunk the process writes, on either pipe, as it arrives, and each
   * turn the worker reports through its hook, said in a line or two. The
   * pipes pass through as text and nothing more: no lines are parsed, no
   * progress is inferred. A turn report is the worker's own.
   */
  onOutput?: (chunk: string, channel: "stdout" | "stderr" | "turn") => void;
  /** Tunes when the continuation loop below gives up. Defaults apply for anything omitted. */
  continuation?: ContinuationConfig;
}): Promise<BridgeOutcome> {
  const startedAt = new Date().toISOString();
  const workspace = await workspaceFor(args.runId);
  if (args.continueFrom) {
    // Everything but the bridge's own `.corbits`: the hook and the packet
    // are this attempt's and are written afresh below.
    const from = args.continueFrom.workspace;
    await cp(from, workspace, { recursive: true, filter: (source) => source !== join(from, ".corbits") });
  }
  await seedBuildWorkspace(workspace, args.seed, { fresh: args.continueFrom === undefined });
  const availability = await bridgeAvailable();

  if (!availability.available) {
    return {
      bridgeId: BRIDGE_ID,
      worker: availability.worker.id,
      available: false,
      exitStatus: null,
      finalText: "",
      stderrTail: availability.detail,
      workspace,
      turnLog: null,
      turns: null,
      toolCalls: null,
      continuedFrom: args.continueFrom?.runId ?? null,
      continuations: 0,
      stopReason: null,
      execution: null,
      startedAt,
      endedAt: new Date().toISOString(),
      checkpointRef: null,
    };
  }

  const worker = availability.worker;

  // A worker with a lifecycle hook is given one for this attempt, in its
  // working directory, and the log it appends to is followed while it runs.
  const turnLog = worker.turnReports ? turnLogFor(args.runId) : null;
  if (turnLog && worker.turnReports) {
    await writeFile(turnLog, "");
    for (const file of worker.turnReports.install(turnLog)) {
      const path = join(workspace, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
  }
  const following = turnLog ? followTurnLog(turnLog, (text) => args.onOutput?.(text, "turn")) : null;

  const config = {
    maxStaleContinuations: args.continuation?.maxStaleContinuations ?? DEFAULT_MAX_STALE_CONTINUATIONS,
    maxContinuations: args.continuation?.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
    maxWallClockMs: args.continuation?.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS,
  };
  const loopStartedAt = Date.now();
  const deadlineAt = loopStartedAt + config.maxWallClockMs;

  // Bounds one invocation to whatever is left of the attempt's wall-clock
  // budget: a deadline signal merged with the caller's own abort, so the
  // budget reaches inside a hung invocation rather than only being checked
  // between them. `timedOut` distinguishes "the deadline is why this
  // invocation ended" from an ordinary cancel, so the loop can report
  // `wall_clock_budget` rather than `aborted`.
  async function invokeBounded(prompt: string): Promise<{ invocation: WorkerInvocation; timedOut: boolean }> {
    const deadlineSignal = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
    const bounded = args.signal ? AbortSignal.any([args.signal, deadlineSignal]) : deadlineSignal;
    const invocation = await spawnWorker(worker, workspace, prompt, bounded, args.onOutput);
    return { invocation, timedOut: deadlineSignal.aborted };
  }

  let { invocation, timedOut } = await invokeBounded(args.prompt);
  const finalTextByInvocation = [invocation.finalText];
  const stderrByInvocation = [invocation.stderr];
  // Baseline is the workspace after the first run; staleness is measured
  // between continuations, never against the pre-run state.
  let previousFingerprint = await snapshotWorkspace(workspace);
  let continuations = 0;
  let staleStreak = 0;
  let stopReason: ContinuationStopReason | null = timedOut ? "wall_clock_budget" : null;

  // Checked after the first invocation, and after every continuation that
  // changed the workspace — never after one that didn't, since an unchanged
  // workspace cannot have produced a different result and the checks cost
  // real time (a worker's own test/typecheck scripts, run for real). A
  // killed (timed-out) invocation's checks would run against a workspace
  // whose stop reason is already decided, so they're skipped too.
  let lastExecution: ExecutionCheck[] | null = timedOut ? null : await runExecutionChecks(workspace);
  if (stopReason === null && allChecksPass(lastExecution)) {
    stopReason = "complete";
  }

  while (stopReason === null) {
    if (args.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (continuations >= config.maxContinuations) {
      stopReason = "turn_budget";
      break;
    }
    if (Date.now() - loopStartedAt >= config.maxWallClockMs) {
      stopReason = "wall_clock_budget";
      break;
    }
    continuations += 1;
    const next = await invokeBounded(continuationPrompt(invocation.finalText, lastExecution));
    invocation = next.invocation;
    finalTextByInvocation.push(invocation.finalText);
    stderrByInvocation.push(invocation.stderr);
    if (next.timedOut) {
      stopReason = "wall_clock_budget";
      break;
    }
    const fingerprint = await snapshotWorkspace(workspace);
    const changed = fingerprint !== previousFingerprint;
    previousFingerprint = fingerprint;
    staleStreak = changed ? 0 : staleStreak + 1;
    if (changed) {
      lastExecution = await runExecutionChecks(workspace);
      if (allChecksPass(lastExecution)) {
        stopReason = "complete";
        break;
      }
    }
    // Stalled means no change AND nothing to act on: a failing check is
    // still something the worker can fix on its next turn, so it is not
    // "stalled" merely because this particular continuation left the
    // workspace untouched.
    const hasFailingCheck = lastExecution !== null && lastExecution.some((check) => !check.ok);
    if (staleStreak >= config.maxStaleContinuations && !hasFailingCheck) {
      stopReason = "stalled";
      break;
    }
  }

  const tally = following ? await following.stop() : null;

  return {
    bridgeId: BRIDGE_ID,
    worker: worker.id,
    available: true,
    exitStatus: invocation.exitStatus,
    // No parsing into synthetic events: each invocation's stdout, joined.
    finalText: finalTextByInvocation.join("\n"),
    stderrTail: stderrByInvocation.join("\n").split("\n").slice(-40).join("\n"),
    workspace,
    turnLog,
    turns: tally?.turns ?? null,
    toolCalls: tally?.toolCalls ?? null,
    continuedFrom: args.continueFrom?.runId ?? null,
    continuations,
    stopReason,
    execution: lastExecution,
    startedAt,
    endedAt: new Date().toISOString(),
    checkpointRef: null,
  };
}

type WorkerInvocation = { exitStatus: number | null; finalText: string; stderr: string };

/** How long a SIGTERM'd worker gets before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** How much longer the drains get, after SIGKILL, before they are force-stopped. */
const DRAIN_GRACE_MS = 2_000;

/**
 * Runs the worker once and waits for it to exit. On abort, `child.kill()` is
 * a request the worker can ignore (or a grandchild can survive holding the
 * stdout/stderr pipe open) — so an unresponsive worker is escalated to
 * SIGKILL after a grace period, and the drains themselves are force-stopped
 * shortly after that, so this function always resolves in bounded time once
 * aborted rather than hanging on a pipe nothing will ever close.
 */
async function spawnWorker(
  worker: BuildWorker,
  workspace: string,
  prompt: string,
  signal: AbortSignal | undefined,
  onOutput: ((chunk: string, channel: "stdout" | "stderr" | "turn") => void) | undefined,
): Promise<WorkerInvocation> {
  const child = Bun.spawn([worker.command, ...worker.run(prompt)], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env },
  });

  const drainAbort = new AbortController();
  let terminating = false;
  let cancelDrainTimer = () => {};
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    child.kill();
    const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    // Deliberately NOT cancelled when `child.exited` resolves: a grandchild
    // that inherited the pipe (this shell worker's `sleep`, say) can keep
    // its write end open long after the direct child has died, which is
    // exactly the case this timer exists to bound. Only clearing it once
    // the drains themselves finish (below) avoids that trap.
    const drainTimer = setTimeout(() => drainAbort.abort(), KILL_GRACE_MS + DRAIN_GRACE_MS);
    cancelDrainTimer = () => clearTimeout(drainTimer);
    child.exited.finally(() => clearTimeout(killTimer));
  };

  // A cancel can land before the process is up; an already-aborted signal
  // never fires its listener, so it is checked as well as listened for.
  if (signal?.aborted) terminate();
  signal?.addEventListener("abort", terminate, { once: true });

  const [stdout, stderr] = await Promise.all([
    drain(child.stdout, (chunk) => onOutput?.(chunk, "stdout"), drainAbort.signal),
    drain(child.stderr, (chunk) => onOutput?.(chunk, "stderr"), drainAbort.signal),
  ]);
  cancelDrainTimer();
  const exitStatus = await child.exited;
  signal?.removeEventListener("abort", terminate);

  return { exitStatus, finalText: stdout, stderr };
}

/**
 * "Complete" means every discovered check passed. A deliverable with no
 * discoverable check (no entry point, no declared `test`/`typecheck`
 * script) can never be proven complete this way — an empty array is not
 * treated as vacuously passing, on purpose (see the file header).
 */
function allChecksPass(execution: ExecutionCheck[] | null): boolean {
  return execution !== null && execution.length > 0 && execution.every((check) => check.ok);
}

/** Bounds one check's output in a continuation prompt: enough to act on, not the whole tail. */
const FAILURE_DETAIL_CHARS = 1500;

/** What the worker is told on a continuation: it is still the same task, and there is no one to ask. */
function continuationPrompt(previousFinalText: string, execution: ExecutionCheck[] | null): string {
  const tail = previousFinalText.trim().slice(-2000);
  const failures = (execution ?? []).filter((check) => !check.ok);
  const failureSection =
    failures.length > 0
      ? [
          "\nThe workspace's own checks ran and some failed. Fix these before anything else:",
          ...failures.map((check) => {
            const output = [check.stdoutTail, check.stderrTail]
              .filter((text) => text.trim().length > 0)
              .join("\n")
              .trim()
              .slice(-FAILURE_DETAIL_CHARS);
            return `\n- ${check.kind} (\`${check.command}\`): exit ${check.exitCode ?? "timeout"} — ${check.detail}${output.length > 0 ? `\n${output}` : ""}`;
          }),
        ].join("\n")
      : "";
  return [
    "Continue the build in this same working directory. This is not a new task: the previous turn ended before the plan was finished, and there is nobody to answer a question or approve a next step — decide and keep working rather than pausing to ask.",
    tail.length > 0 ? `\nThe previous turn ended with:\n${tail}` : "",
    failureSection,
  ].join("\n");
}

/**
 * A fingerprint of the workspace's contents, cheap enough to take after every
 * invocation and compare to the last: unchanged across `maxStaleContinuations`
 * continuations is this bridge's only usable signal that the worker has
 * stopped making progress, since the interface gives no other one. Prefers
 * `git status`/`HEAD` when the workspace is a repo — respects `.gitignore`,
 * so build output and `node_modules` don't count as "progress" — and falls
 * back to a file list of path, size and mtime otherwise.
 *
 * `git status --porcelain` names *what* changed (`M path`, `?? path`), not
 * the content: editing the same untracked or modified file twice in a row
 * produces the identical line both times, which would read as "no change"
 * even though the file's bytes did change — exactly the gap a worker fixing
 * a failing check on an uncommitted file would fall into. Each flagged
 * path's size and mtime are folded in beside the status line to close it,
 * the same signal the non-git fallback below uses.
 *
 * A repo with an unborn HEAD (`.git` exists, but nothing has been committed
 * yet — the seed's baseline commit can fail and still leave `.git/` behind)
 * is a legitimate state, not a git failure: `git status` still succeeds
 * there, and only `rev-parse HEAD` does not, so that specific failure is
 * read as "no commits yet" rather than thrown. `git status` failing is a
 * genuinely broken invocation and still throws.
 */
export async function snapshotWorkspace(workspace: string): Promise<string> {
  if (await pathExists(join(workspace, ".git"))) {
    const status = Bun.spawnSync(["git", "-C", workspace, "status", "--porcelain=v1", "-uall"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (status.exitCode !== 0) {
      throw new Error(`git could not report the state of ${workspace}: ${status.stderr.toString().trim()}`);
    }
    const head = Bun.spawnSync(["git", "-C", workspace, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    const headValue = head.exitCode === 0 ? head.stdout.toString().trim() : "unborn";
    const lines = status.stdout.toString().split("\n").filter((line) => line.length > 0);
    const entries = await Promise.all(
      lines.map(async (line) => {
        // Porcelain v1: two status chars, a space, then the path — a rename
        // reads "R  old -> new"; the destination is what's on disk now.
        const path = line.slice(3).split(" -> ").pop()!.trim();
        const info = await stat(join(workspace, path)).catch(() => null);
        return `${line}:${info ? `${info.size}:${info.mtimeMs}` : "gone"}`;
      }),
    );
    return `${headValue}\n${entries.sort().join("\n")}`;
  }
  return fileTreeFingerprint(workspace);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return false;
    throw cause;
  }
}

/** Every file under `root`, excluding VCS and dependency noise, as `path:size:mtime` lines. */
async function fileTreeFingerprint(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === ".git" || item.name === "node_modules") continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        const info = await stat(full);
        entries.push(`${full.slice(root.length)}:${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await walk(root);
  entries.sort();
  return entries.join("\n");
}

/**
 * Reads a pipe to its end, handing each chunk on as it lands, and returns the
 * whole. `signal` lets a caller force the read to stop even if the pipe
 * itself never reports done — a grandchild of a killed worker can hold the
 * write end open indefinitely, and this is what keeps that from hanging the
 * attempt forever.
 */
async function drain(
  pipe: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  const reader = pipe.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length === 0) continue;
      parts.push(text);
      onChunk(text);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const rest = decoder.decode();
  if (rest.length > 0) {
    parts.push(rest);
    onChunk(rest);
  }
  return parts.join("");
}
