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
 *   inputs         one prompt string, a working directory, a model/provider
 *   outputs        final text on stdout, and an exit status. That is all.
 *   failure        non-zero exit, timeout, or the binary being absent
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
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";
import { buildWorker, type BuildWorker } from "./build-worker.js";

export const BRIDGE_ID = "bounded-local-corbits-exec";

/** Exactly what this bridge can observe. The UI renders from this list. */
export const BRIDGE_CAPABILITIES = {
  promptSubmission: true,
  finalText: true,
  exitStatus: true,
  liveEvents: false,
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
  readonly available: boolean;
  readonly exitStatus: number | null;
  readonly finalText: string;
  readonly stderrTail: string;
  readonly workspace: string;
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

/**
 * Runs one build attempt. Resolves with the outcome whether the attempt
 * succeeded or failed — a failed build is evidence, not an exception.
 */
export async function runBuildAttempt(args: {
  runId: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BridgeOutcome> {
  const startedAt = new Date().toISOString();
  const workspace = await workspaceFor(args.runId);
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
      startedAt,
      endedAt: new Date().toISOString(),
      checkpointRef: null,
    };
  }

  const worker = availability.worker;
  const child = Bun.spawn([worker.command, ...worker.run(args.prompt)], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env },
  });

  const timeout = setTimeout(() => child.kill(), args.timeoutMs ?? 30 * 60_000);
  // A cancel can land before the process is up; an already-aborted signal
  // never fires its listener, so it is checked as well as listened for.
  if (args.signal?.aborted) child.kill();
  args.signal?.addEventListener("abort", () => child.kill(), { once: true });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitStatus = await child.exited;
  clearTimeout(timeout);

  return {
    bridgeId: BRIDGE_ID,
    worker: worker.id,
    available: true,
    exitStatus,
    // Final text as the process emitted it. No parsing into synthetic events.
    finalText: stdout,
    stderrTail: stderr.split("\n").slice(-40).join("\n"),
    workspace,
    startedAt,
    endedAt: new Date().toISOString(),
    checkpointRef: null,
  };
}
