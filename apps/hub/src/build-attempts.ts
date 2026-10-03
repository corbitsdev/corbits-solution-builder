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
 *   <data>/builds/<projectId>/attempts/<n>.json       the outcome, once ended
 *
 * The files are the record; they are what a host that restarts reads. The
 * process itself is memory, so a host that stops cancels every attempt it
 * is running (`stopBuildAttempts`, from the host's own stop) and records
 * each as ended by the signal. An attempt that was started and never
 * recorded as ended — the host was killed outright — is read back from
 * `<n>.started.json`: when the process group it names is still alive the
 * attempt is `detached` (running, but not followed by this host; cancel
 * still reaches it by group), and when it is gone the attempt is `lost`.
 * `attempts/<n>/` is the convention `publish_workspace` reads
 * (`packages/tools-delivery`), kept so the archive and manifest it writes
 * name the attempt the same way.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory, HostError } from "@corbits/embedded-host";
import { BRIDGE_CAPABILITIES, BRIDGE_ID, groupAlive, killGroup, runBuildAttempt, type BridgeOutcome } from "./corbits-exec.js";

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
};

/** The host scans the recorded archive for the first four rules (`quality-scan.ts`), and the supervisor judges the rest. */
const QUALITY_BAR = [
  `--- QUALITY BAR (the work is judged against every rule) ---`,
  `- No stubs: no TODO, FIXME, XXX, "not implemented", placeholder or lorem ipsum text or data in the delivered files (an input's placeholder attribute is fine). Finish it or leave it out and say so.`,
  `- No swallowed errors: no empty catch, \`.catch(() => {})\` or \`except: pass\`. Handle the error or let it propagate; use async/await with try/catch.`,
  `- No unused code, no needless fallbacks; prefer the language's and platform's own primitives over new code.`,
  `- Every requirement id above is implemented and exercised by at least one test that names it; package.json \`scripts.test\` (or the stack's equivalent) runs them all.`,
  `- Run the tests yourself and end your final message with the exact command and its real output. Never claim a pass you did not see.`,
  `- The interface uses the design's components, states and copy, including its empty, loading and error states.`,
  `- A README says what it is, how to install, run and test it, and anything left unbuilt.`,
].join("\n");

/**
 * The prompt the worker is handed:the plan says what to do, the
 * requirements it cites say when it is done, the design says what it looks
 * like, and the frozen stack says what it is built with. Assembled once per
 * attempt and written beside the attempt's directory, so the packet an
 * attempt ran against is immutable and readable afterwards.
 */
export function assembleBuildPrompt(input: BuildPromptInput): string {
  return [
    `Build the software described by this approved plan, against the requirements it cites. Work in the current directory.`,
    ...(input.continuing
      ? [
          ``,
          `An earlier attempt's work is already in the current directory, including any commits it made. Continue from it: keep what is right, finish what is not, and do not start over.`,
        ]
      : []),
    ``,
    ...(input.stackBlock ? [`--- STACK (frozen; build exactly this) ---`, input.stackBlock, ``] : []),
    ...(input.requirementsText ? [`--- REQUIREMENTS ---`, input.requirementsText, ``] : []),
    ...(input.designText ? [`--- DESIGN ---`, input.designText, ``] : []),
    `--- PLAN ---`,
    input.planText,
    ``,
    QUALITY_BAR,
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

export type AttemptRecord = {
  readonly attempt: number;
  readonly state: AttemptState;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** The attempt this one's workspace was copied from, or null for a clean start. */
  readonly continuedFrom: number | null;
  readonly outcome: BridgeOutcome | null;
  readonly workspace: string;
};

/** What is written as `<n>.json` when the worker ends. */
type OutcomeFile = { readonly outcome: BridgeOutcome; readonly continuedFrom: number | null; readonly capabilities: typeof BRIDGE_CAPABILITIES };

/**
 * What is written as `<n>.started.json` the moment an attempt starts, and
 * again once the worker is up with its pid and process group: a host that
 * restarts reads it to tell a worker that is still there from one that is
 * gone, and to reach the former.
 */
type StartedFile = { readonly startedAt: string; readonly continuedFrom: number | null; readonly pid: number | null; readonly pgid: number | null };

type InFlight = {
  readonly controller: AbortController;
  readonly startedAt: string;
  readonly continuedFrom: number | null;
  transcript: string;
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
    return { attempt, state: "running", startedAt: live.startedAt, endedAt: null, continuedFrom: live.continuedFrom, outcome: null, workspace };
  }
  const ended = await readJson<OutcomeFile>(attemptFile(projectId, attempt, ".json"));
  if (ended) {
    return {
      attempt,
      state: ended.outcome.available ? "ended" : "unavailable",
      startedAt: ended.outcome.startedAt,
      endedAt: ended.outcome.endedAt,
      continuedFrom: ended.continuedFrom,
      outcome: ended.outcome,
      workspace,
    };
  }
  const started = await readJson<StartedFile>(attemptFile(projectId, attempt, ".started.json"));
  if (!started) return null;
  // Started by some run of the host and never recorded as ended. The
  // process group says whether the worker is still there.
  const alive = typeof started.pgid === "number" && groupAlive(started.pgid);
  return { attempt, state: alive ? "detached" : "lost", startedAt: started.startedAt, endedAt: null, continuedFrom: started.continuedFrom, outcome: null, workspace };
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
  const live = inFlight.get(key(projectId, attempt));
  if (live) {
    live.controller.abort();
    return true;
  }
  const record = await attemptRecord(projectId, attempt);
  if (record?.state !== "detached") return false;
  const started = await readJson<StartedFile>(attemptFile(projectId, attempt, ".started.json"));
  if (typeof started?.pgid !== "number") return false;
  killGroup(started.pgid);
  return true;
}

/**
 * Cancels every attempt this host is running and waits for each record to
 * be written: the host's own stop calls this, so a worker never outlives
 * the host that started it and the attempt is recorded as ended by the
 * signal rather than found lost on the next start.
 */
export async function stopBuildAttempts(): Promise<void> {
  stopping = true;
  // A start between its reservation and its registration is not in flight
  // yet; it is waited for, so the worker it is about to spawn is ended too.
  await Promise.allSettled([...starting.values()]);
  const running = [...inFlight.values()];
  for (const live of running) live.controller.abort();
  await Promise.all(running.map((live) => live.done));
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
  const startedAt = new Date().toISOString();
  await writeFile(attemptFile(projectId, attempt, ".prompt.txt"), prompt);
  const startedFile = attemptFile(projectId, attempt, ".started.json");
  const writeStarted = (process: { pid: number | null; pgid: number | null }) =>
    writeFile(startedFile, `${JSON.stringify({ startedAt, continuedFrom: continueFrom, ...process } satisfies StartedFile)}\n`);
  await writeStarted({ pid: null, pgid: null });
  const logPath = attemptFile(projectId, attempt, ".log");
  await writeFile(logPath, "");

  const controller = new AbortController();
  // Registered before the first await of the run: the attempt is "running"
  // from the moment the caller has its number, so a cancel can arrive
  // before the process is up and must still reach the worker.
  const live: InFlight = {
    controller,
    startedAt,
    continuedFrom: continueFrom,
    transcript: "",
    done: Promise.resolve(),
  };
  inFlight.set(key(projectId, attempt), live);
  const done = (async () => {
    const log = Bun.file(logPath).writer();
    const record = async (outcome: BridgeOutcome) => {
      await writeFile(
        attemptFile(projectId, attempt, ".json"),
        `${JSON.stringify({ outcome, continuedFrom: continueFrom, capabilities: BRIDGE_CAPABILITIES } satisfies OutcomeFile, null, 2)}\n`,
      );
    };
    try {
      const outcome = await runBuildAttempt({
        workspace,
        prompt,
        turnLog: attemptFile(projectId, attempt, ".turns.jsonl"),
        signal: controller.signal,
        ...(continueFrom !== null ? { continueFrom: attemptWorkspace(projectId, continueFrom) } : {}),
        onOutput: (chunk) => {
          live.transcript = (live.transcript + chunk).slice(-TRANSCRIPT_KEEP);
          log.write(chunk);
          void log.flush();
        },
        onStarted: (process) => void writeStarted(process).catch(() => undefined),
      });
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

  return { attempt, state: "running", startedAt, endedAt: null, continuedFrom: continueFrom, outcome: null, workspace };
}
