/**
 * One build attempt, from the request that starts it to the record that
 * ends it.
 *
 * The bounded bridge (`corbits-exec.ts`) reports an outcome and nothing else.
 * What the outcome *means* is not decided here either: a worker that could
 * not run at all is reported as unavailable, with the reason; a worker that
 * ran leaves its work behind whatever its exit status, because whether what
 * it left is evidence is a person's call, never the exit code's.
 *
 * Every attempt is one directory under the project's builds:
 *
 *   <data>/builds/<projectId>/attempts/<n>/           the worker's cwd
 *                                                     (`buildsRoot`)
 *   <data>/builds/<projectId>/attempts/<n>.prompt.txt what it was handed
 *   <data>/builds/<projectId>/attempts/<n>.log        stdout, stderr and
 *                                                     turn reports, in order
 *   <data>/builds/<projectId>/attempts/<n>.turns.jsonl the worker's own hook log
 *   <data>/builds/<projectId>/attempts/<n>.stdout     what the worker wrote, as files
 *   <data>/builds/<projectId>/attempts/<n>.stderr       (#783), so no pipe ties
 *   <data>/builds/<projectId>/attempts/<n>.exit         it to this host
 *   <data>/builds/<projectId>/attempts/<n>.json       the outcome, once ended
 *
 * The files are the record; they are what a host that restarts reads. The
 * worker writes to files, not to the host, so the host's own stop leaves
 * it running (`stopBuildAttempts` releases each attempt) and the next host
 * to start follows it again (`adoptRunningAttempts`): an eight-hour build
 * is not lost to a restart. An attempt that was started and never
 * recorded as ended is read back from `<n>.started.json`: when the
 * process group it names is still alive the attempt is adopted and is
 * `running` again, or `detached` until it is; when the group is gone and
 * the worker left an exit status the attempt is recorded from its files,
 * and when it left none it is `lost`. On Windows there are no process
 * groups and no files: the worker is piped, and ends with the host.
 * `attempts/<n>/` is the convention `publish_workspace` reads
 * (`packages/tools-delivery`), kept so the archive and manifest it writes
 * name the attempt the same way.
 */
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDirectory, HostError } from "@corbits/embedded-host";
import { BRIDGE_CAPABILITIES, BRIDGE_ID, CANCEL_GRACE_MS, groupAlive, killGroup, recordedExit, recordedOutput, runBuildAttempt, stderrTail, type BridgeOutcome } from "./corbits-exec.js";
import { followFile } from "./file-follow.js";
import { followTurnLog } from "./turn-reports.js";
import { BUILD_WORKERS, buildWorker } from "./build-worker.js";
import { sumUsage, turnLogModels, usageCalls, type AttemptUsage } from "./build-usage.js";
import { buildDocumentsRule, MANUAL_IMAGES_DIR, README_PATH, USER_MANUAL_PATH } from "@solutions-builder/specialist-runtime/build-documents";

/** Enough to read the last stretch of a long build in a window; the file has it all. */
const TRANSCRIPT_KEEP = 200_000;

/**
 * Where every project's attempts live: `SOLUTIONS_BUILDER_BUILDS_DIR` when
 * set (a build directory grows large, and a different disk is a reasonable
 * choice; a smoke points it at a scratch directory), else `builds/` under
 * the host's data directory.
 */
export function buildsRoot(): string {
  return process.env.SOLUTIONS_BUILDER_BUILDS_DIR?.trim() || join(dataDirectory(), "builds");
}

export function projectBuildsDirectory(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new HostError("validation_failed", "That is not a project id.");
  return join(buildsRoot(), projectId, "attempts");
}

export function attemptWorkspace(projectId: string, attempt: number): string {
  return join(projectBuildsDirectory(projectId), String(attempt));
}

function attemptFile(projectId: string, attempt: number, suffix: string): string {
  return join(projectBuildsDirectory(projectId), `${String(attempt)}${suffix}`);
}

/** The next attempt number: one past the highest numbered directory, 1 when there is none. */
export function nextAttemptNumber(existing: readonly string[]): number {
  const numbers = existing.filter((name) => /^\d+$/.test(name)).map((name) => Number(name));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/** The numbered attempt directories a project has, lowest first. */
export async function attemptNumbers(projectId: string): Promise<number[]> {
  try {
    const entries = await readdir(projectBuildsDirectory(projectId), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** What the client hands over for the prompt: the frozen material, as text. */
export type BuildPromptInput = {
  readonly planText: string;
  readonly requirementsText: string;
  /** The stage 4 design, as text, when there is one. */
  readonly designText: string;
  /** The frozen stack block from stage 7's freeze, when there is one. */
  readonly stackBlock: string;
  /** The delivery target stage 7 chose. */
  readonly target: string;
  /** A hash or version naming the approved plan, so the packet names what it was built from. */
  readonly planRef: string;
  readonly continuing: boolean;
  /** Files written into the workspace before the worker starts (#686): AGENTS.md, the documents, QUESTIONS.md. */
  readonly files?: readonly { readonly path: string; readonly content: string }[];
  /** The workspace's output language, for the documents the build ships (#733); American English when unset. */
  readonly language?: string;
};

/** A workspace-relative file path a seeded file may take: no absolute paths, no `..`, no hidden traversal. */
export function safeWorkspacePath(path: string): boolean {
  if (path.length === 0 || path.length > 200 || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * The prompt the worker is handed: the plan says what to do, the
 * requirements it cites say when it is done, the design says what it looks
 * like, and the frozen stack says what it is built with. Assembled once per
 * attempt and written beside the attempt's directory, so the packet an
 * attempt ran against is immutable and readable afterwards.
 */
export function assembleBuildPrompt(input: BuildPromptInput): string {
  const seeded = (input.files ?? []).map((file) => file.path);
  return [
    `Build the software described by this approved plan, against the requirements it cites. Work in the current directory.`,
    ...(seeded.length > 0
      ? [``, `The documents are also in the current directory as files: ${seeded.join(", ")}. Read AGENTS.md first; it says which document wins where they disagree, and which acceptance criteria mean done.`]
      : []),
    ...(input.continuing
      ? [
          ``,
          `An earlier attempt's work is already in the current directory, including any commits it made. Continue from it: keep what is right, finish what is not, and do not start over.`,
        ]
      : []),
    ``,
    // The progress record (#697): the person watching reads the plan's
    // task numbers off the worker's own commits and status file, so the
    // page can say how far the build got without inferring anything.
    buildDocumentsRule(input.language),
    ``,
    `Keep a progress record the person can read. Name the plan task every commit is for in its subject, as "(Task N)" or "(Tasks N, M)". Keep STATUS.md at the root of the working directory with one section per finished task, headed with the task's number and name. Your final message says which tasks are done and which are not.`,
    ``,
    ...(input.stackBlock ? [`--- STACK (frozen; build exactly this) ---`, input.stackBlock, ``] : []),
    ...(input.requirementsText ? [`--- REQUIREMENTS ---`, input.requirementsText, ``] : []),
    ...(input.designText ? [`--- DESIGN ---`, input.designText, ``] : []),
    `--- PLAN ---`,
    input.planText,
    ``,
    `Approved plan: ${input.planRef || "unknown"}.`,
    `Target: ${input.target || "unknown"}.`,
  ].join("\n");
}

/**
 * `running`: this host is driving the worker. `detached`: a worker an
 * earlier run of the host started is still alive, and this host only knows
 * its process group. `lost`: started, never recorded as ended, and gone.
 */
export type AttemptState = "running" | "ended" | "unavailable" | "detached" | "lost";

/**
 * Who told the worker to stop, when this host did: a person's cancel, or
 * the host's own stop. The worker's exit says only that it was signalled
 * (143, or a signal); this says why, so the record is not read as a crash.
 */
export type EndedBy = "cancel" | "host_stop";

export type AttemptRecord = {
  readonly attempt: number;
  readonly state: AttemptState;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** The attempt this one's workspace was copied from, or null for a clean start. */
  readonly continuedFrom: number | null;
  readonly outcome: BridgeOutcome | null;
  readonly workspace: string;
  /** Null while running, and for a worker that ended on its own. */
  readonly endedBy: EndedBy | null;
  /** What the attempt has spent so far, in the worker's own counts (#785); null for a worker that keeps no usage log. */
  readonly usage: AttemptUsage | null;
};

/** What is written as `<n>.json` when the worker ends. */
type OutcomeFile = { readonly outcome: BridgeOutcome; readonly continuedFrom: number | null; readonly capabilities: typeof BRIDGE_CAPABILITIES; readonly endedBy?: EndedBy | null };

/**
 * What is written as `<n>.started.json` the moment an attempt starts, and
 * again once the worker is up with its pid and process group: a host that
 * restarts reads it to tell a worker that is still there from one that is
 * gone, and to reach the former.
 */
type StartedFile = {
  readonly startedAt: string;
  readonly continuedFrom: number | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  /** Which worker, so a host that adopts the attempt can record it; absent from a host before #783. */
  readonly worker?: string;
  readonly command?: string;
};

type InFlight = {
  /** Aborted to end the worker: a cancel, or a host stop where the worker cannot run on. */
  readonly controller: AbortController;
  /** Aborted to stop following and leave the worker running: the host's own stop. */
  readonly release: AbortController;
  readonly startedAt: string;
  readonly continuedFrom: number | null;
  transcript: string;
  /** Set before the abort that ends the worker, so the record says who did. */
  endedBy: EndedBy | null;
  /** Settles once the record is written and the entry removed. */
  done: Promise<unknown>;
};

/** Keyed `<projectId>:<attempt>`; memory only, see the module doc. */
const inFlight = new Map<string, InFlight>();

/**
 * Projects whose next attempt is being set up and has no number yet. Taken
 * synchronously, before the first await of a start, so two starts that
 * land together cannot both pass the running check and claim one number.
 */
const starting = new Map<string, Promise<unknown>>();

const RUNNING_CONFLICT = "A build attempt is already running for this project. Cancel it, or wait for it to end.";

/** Whether a worker here writes to files and can outlive the host. */
const WORKERS_OUTLIVE_HOST = process.platform !== "win32";

/** How often an adopted worker is looked for. */
const ADOPTED_POLL_MS = 1_000;

const recordFiles = (projectId: string, attempt: number) => ({
  stdout: attemptFile(projectId, attempt, ".stdout"),
  stderr: attemptFile(projectId, attempt, ".stderr"),
  exit: attemptFile(projectId, attempt, ".exit"),
});

/** Set by `stopBuildAttempts`: from then on no attempt starts on this host. */
let stopping = false;

function key(projectId: string, attempt: number): string {
  return `${projectId}:${String(attempt)}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function attemptRecord(projectId: string, attempt: number): Promise<AttemptRecord | null> {
  const workspace = attemptWorkspace(projectId, attempt);
  const live = inFlight.get(key(projectId, attempt));
  if (live) {
    const started = await readJson<StartedFile>(attemptFile(projectId, attempt, ".started.json"));
    const usage = await attemptUsage(projectId, attempt, started?.worker ?? null, { from: live.startedAt, to: null });
    return { attempt, state: "running", startedAt: live.startedAt, endedAt: null, continuedFrom: live.continuedFrom, outcome: null, workspace, endedBy: null, usage };
  }
  const ended = await readJson<OutcomeFile>(attemptFile(projectId, attempt, ".json"));
  if (ended) {
    return {
      attempt,
      state: ended.outcome.available ? "ended" : "unavailable",
      endedBy: ended.endedBy ?? null,
      usage: ended.outcome.available ? await attemptUsage(projectId, attempt, ended.outcome.worker, { from: ended.outcome.startedAt, to: ended.outcome.endedAt }) : null,
      startedAt: ended.outcome.startedAt,
      endedAt: ended.outcome.endedAt,
      continuedFrom: ended.continuedFrom,
      outcome: ended.outcome,
      workspace,
    };
  }
  const started = await readJson<StartedFile>(attemptFile(projectId, attempt, ".started.json"));
  if (!started) return null;
  // Started by an earlier run of the host and never recorded as ended:
  // followed again from here when it can be (#783), which is the common
  // case; detached for the moment it cannot be; lost when it is gone.
  if (await adoptAttempt(projectId, attempt, started)) return attemptRecord(projectId, attempt);
  const alive = typeof started.pgid === "number" && groupAlive(started.pgid);
  const usage = await attemptUsage(projectId, attempt, started.worker ?? null, { from: started.startedAt, to: alive ? null : new Date().toISOString() });
  return { attempt, state: alive ? "detached" : "lost", startedAt: started.startedAt, endedAt: null, continuedFrom: started.continuedFrom, outcome: null, workspace, endedBy: null, usage };
}

/**
 * What an attempt has spent (#785): the worker's usage log summed over the
 * attempt's window, with the models its own turns name. The worker is the
 * one recorded for the attempt, or the one chosen now for an attempt from
 * before the worker was recorded; a worker without a usage log is null.
 */
async function attemptUsage(projectId: string, attempt: number, workerId: string | null, window: { from: string; to: string | null }): Promise<AttemptUsage | null> {
  const kind = workerId ? BUILD_WORKERS.find((entry) => entry.id === workerId) : await buildWorker().catch(() => null);
  const log = kind?.usageLog;
  if (!log) return null;
  try {
    const [calls, models] = await Promise.all([usageCalls(log.path(), log.parse), turnLogModels(attemptFile(projectId, attempt, ".turns.jsonl"))]);
    return sumUsage(calls, window, log.source, models);
  } catch {
    return null;
  }
}

export async function listAttempts(projectId: string): Promise<AttemptRecord[]> {
  const records = await Promise.all((await attemptNumbers(projectId)).map((attempt) => attemptRecord(projectId, attempt)));
  return records.filter((record): record is AttemptRecord => record !== null);
}

/** The log so far: the file's tail, which is also what a window shows. */
export async function attemptLog(projectId: string, attempt: number): Promise<string> {
  const live = inFlight.get(key(projectId, attempt));
  if (live) return live.transcript;
  try {
    const text = await readFile(attemptFile(projectId, attempt, ".log"), "utf8");
    return text.slice(-TRANSCRIPT_KEEP);
  } catch {
    return "";
  }
}

/** What an attempt's directory records of the worker's own progress (#697). */
export type WorkspaceReport = {
  /** The worker's commits, oldest first: hash, author date, subject. Empty without a repository. */
  readonly commits: readonly { readonly hash: string; readonly at: string; readonly subject: string }[];
  /** STATUS.md at the root, as the worker wrote it; null when there is none. */
  readonly status: string | null;
  /** QUESTIONS.md at the root; null when there is none. */
  readonly questions: string | null;
  /** The two documents every build ships (#733): present or not, and how many pictures the manual has. */
  readonly documents: { readonly readme: boolean; readonly userManual: boolean; readonly manualImages: number };
};

const REPORT_FILE_KEEP = 60_000;
const COMMITS_KEEP = 1_000;

/** `git log` as a list, oldest first; the parser the report and its test share. */
export function parseGitLog(text: string): WorkspaceReport["commits"] {
  const commits: { hash: string; at: string; subject: string }[] = [];
  for (const line of text.split("\n")) {
    const [hash, at, ...rest] = line.split("\t");
    if (!hash || !at) continue;
    commits.push({ hash, at, subject: rest.join("\t") });
  }
  return commits;
}

/**
 * Reads the progress record out of a working directory: the repository's
 * log and the two files the packet asks the worker to keep. Read, never
 * inferred: a commit subject is the worker's own claim about a task.
 */
export async function workspaceReportAt(directory: string): Promise<WorkspaceReport> {
  const readText = async (name: string): Promise<string | null> => {
    try {
      const text = await readFile(join(directory, name), "utf8");
      return text.length > REPORT_FILE_KEEP ? `${text.slice(0, REPORT_FILE_KEEP)}\n…` : text;
    } catch {
      return null;
    }
  };
  let commits: WorkspaceReport["commits"] = [];
  try {
    const log = Bun.spawn(["git", "log", "--reverse", `--max-count=${String(COMMITS_KEEP)}`, "--format=%h%x09%aI%x09%s"], { cwd: directory, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(log.stdout).text();
    if ((await log.exited) === 0) commits = parseGitLog(text);
  } catch {
    // No git, or no repository: no commits to report.
  }
  const exists = (name: string) => stat(join(directory, name)).then((info) => info.isFile(), () => false);
  const manualImages = readdir(join(directory, MANUAL_IMAGES_DIR)).then((names) => names.filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name)).length, () => 0);
  const [status, questions, readme, userManual, images] = await Promise.all([readText("STATUS.md"), readText("QUESTIONS.md"), exists(README_PATH), exists(USER_MANUAL_PATH), manualImages]);
  return { commits, status, questions, documents: { readme, userManual, manualImages: images } };
}

/** The progress record of an attempt's directory. */
export function attemptWorkspaceReport(projectId: string, attempt: number): Promise<WorkspaceReport> {
  return workspaceReportAt(attemptWorkspace(projectId, attempt));
}

/** The prompt an attempt was handed, as written when it started. */
export async function attemptPrompt(projectId: string, attempt: number): Promise<string | null> {
  try {
    return await readFile(attemptFile(projectId, attempt, ".prompt.txt"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Stops the worker for an attempt: the one this host is driving, or the
 * group a detached one still runs in. True when there was one to stop.
 */
export async function cancelBuildAttempt(projectId: string, attempt: number): Promise<boolean> {
  // The record first: reading it adopts a worker an earlier host left running.
  const record = await attemptRecord(projectId, attempt);
  const live = inFlight.get(key(projectId, attempt));
  if (live) {
    live.endedBy = "cancel";
    live.controller.abort();
    return true;
  }
  if (record?.state !== "detached") return false;
  const started = await readJson<StartedFile>(attemptFile(projectId, attempt, ".started.json"));
  if (typeof started?.pgid !== "number") return false;
  killGroup(started.pgid);
  return true;
}

/**
 * The host's own stop. Every attempt it is following is released to run
 * on (#783): the worker writes to files, not to this process, and the
 * next host to start follows it again. Where a worker cannot outlive the
 * host (Windows: piped, no process group) it is cancelled and recorded as
 * ended by the host's stop. Either way nothing starts after.
 */
export async function stopBuildAttempts(): Promise<void> {
  stopping = true;
  // A start between its reservation and its registration is not in flight
  // yet; it is waited for, so the worker it is about to spawn is handled too.
  await Promise.allSettled([...starting.values()]);
  const running = [...inFlight.entries()];
  for (const [entry, live] of running) {
    if (WORKERS_OUTLIVE_HOST) {
      console.log(`[build] leaving attempt ${entry} running; the next host to start will follow it`);
      live.release.abort();
    } else {
      live.endedBy ??= "host_stop";
      live.controller.abort();
    }
  }
  await Promise.all(running.map(([, live]) => live.done));
}

/**
 * Follows again every attempt an earlier run of the host left running,
 * and records every one that ended while no host was there. Called once
 * when the host starts; `attemptRecord` does the same for one attempt on
 * demand. Returns how many are being followed again.
 */
export async function adoptRunningAttempts(): Promise<number> {
  let adopted = 0;
  let projects: string[];
  try {
    projects = (await readdir(buildsRoot(), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return 0;
  }
  for (const projectId of projects) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) continue;
    for (const attempt of await attemptNumbers(projectId)) {
      if (inFlight.has(key(projectId, attempt))) continue;
      if (await readJson<OutcomeFile>(attemptFile(projectId, attempt, ".json"))) continue;
      const started = await readJson<StartedFile>(attemptFile(projectId, attempt, ".started.json"));
      if (started && (await adoptAttempt(projectId, attempt, started))) adopted += 1;
    }
  }
  return adopted;
}

/**
 * Takes up an attempt started by an earlier run of the host: its worker
 * still running, or ended with its exit on disk. Idempotent: an attempt
 * already in flight is left as it is. False when there is nothing to take
 * up — no process group recorded, or the worker gone without an exit,
 * which is `lost`.
 */
async function adoptAttempt(projectId: string, attempt: number, started: StartedFile): Promise<boolean> {
  const entry = key(projectId, attempt);
  if (inFlight.has(entry)) return true;
  // A stopping host has just released what it followed; it takes nothing up.
  if (stopping || !WORKERS_OUTLIVE_HOST || typeof started.pgid !== "number") return false;
  const pgid = started.pgid;
  const files = recordFiles(projectId, attempt);
  const exitKnown = (await recordedExit(files.exit)) !== null;
  if (!exitKnown && !groupAlive(pgid)) return false;

  const workspace = attemptWorkspace(projectId, attempt);
  const logPath = attemptFile(projectId, attempt, ".log");
  const turnLog = attemptFile(projectId, attempt, ".turns.jsonl");
  const controller = new AbortController();
  const release = new AbortController();
  const live: InFlight = {
    controller,
    release,
    startedAt: started.startedAt,
    continuedFrom: started.continuedFrom,
    transcript: (await readFile(logPath, "utf8").catch(() => "")).slice(-TRANSCRIPT_KEEP),
    endedBy: null,
    done: Promise.resolve(),
  };
  inFlight.set(entry, live);
  const say = (chunk: string) => {
    live.transcript = (live.transcript + chunk).slice(-TRANSCRIPT_KEEP);
    void appendFile(logPath, chunk).catch(() => undefined);
  };
  // From here on: what the worker wrote while no host was there is in its
  // files, not repeated into the log.
  const followers = [followFile(files.stdout, say, { from: "end" }), followFile(files.stderr, say, { from: "end" })];
  const turns = followTurnLog(turnLog, say, 500, "end");
  say(`── the host started again and is following the worker from here\n`);
  controller.signal.addEventListener("abort", () => killGroup(pgid), { once: true });

  live.done = (async () => {
    try {
      // Until the worker leaves its exit, or is gone, or this host stops too.
      while (!release.signal.aborted && (await recordedExit(files.exit)) === null && groupAlive(pgid)) {
        await new Promise((resolve) => setTimeout(resolve, ADOPTED_POLL_MS));
      }
      if (release.signal.aborted) return;
      // What the worker left running in its group ends with it, as when
      // this host drove it; the exit file says the worker itself is done.
      if (groupAlive(pgid)) {
        killGroup(pgid);
        const deadline = Date.now() + CANCEL_GRACE_MS + 1_000;
        while (groupAlive(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const [stdout, stderr] = await recordedOutput(files);
      const tally = await turns.stop();
      const outcome: BridgeOutcome = {
        bridgeId: BRIDGE_ID,
        worker: started.worker ?? "",
        command: started.command ?? "",
        available: true,
        exitStatus: await recordedExit(files.exit),
        signal: null,
        finalText: stdout,
        stderrTail: stderrTail(stderr),
        workspace,
        turnLog,
        turns: tally.turns,
        toolCalls: tally.toolCalls,
        startedAt: started.startedAt,
        endedAt: new Date().toISOString(),
        checkpointRef: null,
      };
      await writeFile(
        attemptFile(projectId, attempt, ".json"),
        `${JSON.stringify({ outcome, continuedFrom: started.continuedFrom, capabilities: BRIDGE_CAPABILITIES, endedBy: live.endedBy } satisfies OutcomeFile, null, 2)}\n`,
      );
    } finally {
      await Promise.all(followers.map((follower) => follower.stop()));
      inFlight.delete(entry);
    }
  })();
  return true;
}

/**
 * True while any attempt for the project is running on this host: one this
 * host is driving or setting up, or one an earlier run of the host started
 * that is still alive (`detached`) — a second worker beside it would write
 * into the same project's builds.
 */
export async function projectHasRunningAttempt(projectId: string): Promise<boolean> {
  if (starting.has(projectId)) return true;
  for (const entry of inFlight.keys()) if (entry.startsWith(`${projectId}:`)) return true;
  return (await listAttempts(projectId)).some((record) => record.state === "detached");
}

/**
 * Starts the next attempt for a project and returns at once with its
 * number; the worker runs on, and the record files say how it ended.
 * One attempt per project at a time: two workers in one project's builds
 * would each be reported as the other's.
 */
export async function startBuildAttempt(args: {
  projectId: string;
  prompt: BuildPromptInput;
  continueFrom?: number | undefined;
}): Promise<AttemptRecord> {
  const { projectId } = args;
  if (args.prompt.planText.trim().length === 0) {
    throw new HostError("validation_failed", "The approved plan has no text to build from. Stage 6's plan must be readable before an attempt can start.");
  }
  if (stopping) throw new HostError("validation_failed", "The host is stopping; no build attempt can start.");
  if (starting.has(projectId) || [...inFlight.keys()].some((entry) => entry.startsWith(`${projectId}:`))) {
    throw new HostError("conflict", RUNNING_CONFLICT, {}, false);
  }
  // Reserved synchronously, before the first await, and the reservation is
  // the start itself so a stop can wait for it. A detached worker is
  // looked for inside, once the project is this call's.
  const reserved = startReserved(args);
  starting.set(projectId, reserved.catch(() => undefined));
  try {
    return await reserved;
  } finally {
    starting.delete(projectId);
  }
}

/** The start proper, once the project is reserved to this call. */
async function startReserved(args: { projectId: string; prompt: BuildPromptInput; continueFrom?: number | undefined }): Promise<AttemptRecord> {
  const { projectId } = args;
  if ((await listAttempts(projectId)).some((record) => record.state === "detached")) {
    throw new HostError("conflict", RUNNING_CONFLICT, {}, false);
  }
  const directory = projectBuildsDirectory(projectId);
  await mkdir(directory, { recursive: true });
  const existing = await attemptNumbers(projectId);
  const continueFrom = args.continueFrom ?? null;
  if (continueFrom !== null && !existing.includes(continueFrom)) {
    throw new HostError("validation_failed", `There is no attempt ${String(continueFrom)} to continue from.`);
  }
  const attempt = nextAttemptNumber(existing.map(String));
  const workspace = attemptWorkspace(projectId, attempt);
  await mkdir(workspace, { recursive: true });

  const prompt = assembleBuildPrompt({ ...args.prompt, continuing: continueFrom !== null });
  // The corpus as files (#ISSUE), written before the worker starts; a path
  // that could leave the workspace is refused rather than written.
  for (const file of args.prompt.files ?? []) {
    if (!safeWorkspacePath(file.path)) throw new HostError("validation_failed", `A seeded file has an unsafe path: ${file.path}`);
    const target = join(workspace, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const startedAt = new Date().toISOString();
  await writeFile(attemptFile(projectId, attempt, ".prompt.txt"), prompt);
  const startedFile = attemptFile(projectId, attempt, ".started.json");
  const writeStarted = (process: { pid: number | null; pgid: number | null; worker?: string; command?: string }) =>
    writeFile(startedFile, `${JSON.stringify({ startedAt, continuedFrom: continueFrom, ...process } satisfies StartedFile)}\n`);
  await writeStarted({ pid: null, pgid: null });
  const logPath = attemptFile(projectId, attempt, ".log");
  await writeFile(logPath, "");

  const controller = new AbortController();
  const release = new AbortController();
  // Registered before the first await of the run: the attempt is "running"
  // from the moment the caller has its number, so a cancel can arrive
  // before the process is up and must still reach the worker.
  const live: InFlight = {
    controller,
    release,
    startedAt,
    continuedFrom: continueFrom,
    transcript: "",
    endedBy: null,
    done: Promise.resolve(),
  };
  inFlight.set(key(projectId, attempt), live);
  const done = (async () => {
    const log = Bun.file(logPath).writer();
    const record = async (outcome: BridgeOutcome) => {
      await writeFile(
        attemptFile(projectId, attempt, ".json"),
        `${JSON.stringify({ outcome, continuedFrom: continueFrom, capabilities: BRIDGE_CAPABILITIES, endedBy: live.endedBy } satisfies OutcomeFile, null, 2)}\n`,
      );
    };
    try {
      const outcome = await runBuildAttempt({
        workspace,
        prompt,
        turnLog: attemptFile(projectId, attempt, ".turns.jsonl"),
        signal: controller.signal,
        record: recordFiles(projectId, attempt),
        release: release.signal,
        ...(continueFrom !== null ? { continueFrom: attemptWorkspace(projectId, continueFrom) } : {}),
        onOutput: (chunk) => {
          live.transcript = (live.transcript + chunk).slice(-TRANSCRIPT_KEEP);
          log.write(chunk);
          void log.flush();
        },
        onStarted: (process) => void writeStarted(process).catch(() => undefined),
      });
      if (outcome === null) {
        // Released: the worker runs on, and the next host to start follows it.
        log.write(`── the host is stopping; the worker runs on, and will be followed again when the host starts\n`);
        return null;
      }
      await record(outcome);
      return outcome;
    } catch (cause) {
      // The bridge itself failed — a copy that could not be made, a hook
      // that could not be placed — before or around the worker. Recorded
      // as an attempt that could not run, with the reason, so it is not
      // mistaken for a worker that ran, nor for one this host lost.
      const detail = cause instanceof Error ? cause.message : String(cause);
      const crashed: BridgeOutcome = {
        bridgeId: BRIDGE_ID,
        worker: "",
        command: "",
        available: false,
        exitStatus: null,
        signal: null,
        finalText: "",
        stderrTail: `The build bridge could not drive the worker: ${detail}`,
        workspace,
        turnLog: null,
        turns: null,
        toolCalls: null,
        startedAt,
        endedAt: new Date().toISOString(),
        checkpointRef: null,
      };
      log.write(`${crashed.stderrTail}\n`);
      await record(crashed).catch(() => undefined);
      console.error(`[build] ${projectId} attempt ${String(attempt)} could not be driven`, cause);
      return crashed;
    } finally {
      await log.end();
      inFlight.delete(key(projectId, attempt));
    }
  })();
  live.done = done;

  return { attempt, state: "running", startedAt, endedAt: null, continuedFrom: continueFrom, outcome: null, workspace, endedBy: null, usage: null };
}
