/**
 * How far a build attempt got through the plan, in the worker's own words
 * (#697).
 *
 * The plan numbers its tasks under "## Tasks in order". The worker is asked
 * to name the task every commit is for and to keep a STATUS.md with a
 * section per finished task, and its turn lines name the tasks it hands to
 * its agents. This module reads those three records against the plan's
 * list and says, per task, whether the worker has committed work for it,
 * has named it as under way, or has not named it at all. Nothing here
 * judges the work: a committed task is one the worker says it did.
 */
import type { BuildAttempt, BuildWorkspaceReport } from "../../client.ts";

export type PlanTask = { readonly number: number; readonly title: string };

export type TaskState = "committed" | "started" | "unnamed";

export type TaskProgress = {
  readonly number: number;
  readonly title: string;
  readonly state: TaskState;
  /** The worker's own words that placed it: a commit subject, or where it was named. */
  readonly evidence: string | null;
};

export type BuildProgress = {
  readonly tasks: readonly TaskProgress[];
  readonly committed: number;
  readonly started: number;
  readonly unnamed: number;
  /** The worker's commits, however many name a task. */
  readonly commits: number;
};

const TITLE_KEEP = 90;

/** The plan's numbered tasks under "## Tasks in order", in order. */
export function planTasks(planText: string): PlanTask[] {
  const lines = planText.split("\n");
  const start = lines.findIndex((line) => /^##\s+tasks in order\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const tasks: PlanTask[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line.trim());
    if (numbered) {
      tasks.push({ number: Number(numbered[1]), title: taskTitle(numbered[2] ?? "") });
      continue;
    }
    // A table row, `| T1 | Scaffold … | … |`, as some plans lay the list out (#777).
    const row = /^\|\s*T?(\d+)\s*\|\s*([^|]+)\|/.exec(line.trim());
    if (row) tasks.push({ number: Number(row[1]), title: taskTitle(row[2] ?? "") });
  }
  return tasks;
}

/** The task's own name: the text before its first colon or sentence end, bounded. */
function taskTitle(text: string): string {
  const plain = text.replace(/\*\*/g, "").replace(/`/g, "");
  const cut = plain.search(/:\s|\.\s|\s[—–-]\s/);
  const title = (cut > 0 ? plain.slice(0, cut) : plain).trim();
  return title.length > TITLE_KEEP ? `${title.slice(0, TITLE_KEEP - 1)}…` : title;
}

/**
 * Every task number a text names: "Task 5", "Tasks 5-8", "Tasks 16 and 17",
 * "Tasks 22, 24", "Task 21-part" (21). A number must follow the word; a bare
 * number is not a task.
 */
export function taskNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  // `T36`, `T36–T37`, `T1-T28` (#777): the short form a plan's table and a worker's commits use.
  for (const match of text.matchAll(/\bT(\d+)(?:\s*[–-]\s*T?(\d+))?\b/g)) {
    const from = Number(match[1]);
    const to = match[2] !== undefined ? Number(match[2]) : from;
    if (to >= from && to - from < 200) for (let n = from; n <= to; n += 1) numbers.add(n);
  }
  for (const match of text.matchAll(/\bTasks?\s+(\d+(?:\s*(?:[–-]\s*\d+|,\s*\d+|(?:,\s*)?and\s+\d+|&\s*\d+))*)/gi)) {
    const list = match[1] ?? "";
    for (const part of list.split(/,|\band\b|&/)) {
      const range = /(\d+)\s*[–-]\s*(\d+)/.exec(part);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (to >= from && to - from < 200) for (let n = from; n <= to; n += 1) numbers.add(n);
        continue;
      }
      const single = /\d+/.exec(part);
      if (single) numbers.add(Number(single[0]));
    }
  }
  return numbers;
}

/**
 * Each plan task against the record: committed when a commit subject or a
 * STATUS.md heading names it, started when only the worker's turn lines do,
 * unnamed otherwise.
 */
export function taskProgress(tasks: readonly PlanTask[], report: BuildWorkspaceReport | null, log: string): BuildProgress {
  const commits = report?.commits ?? [];
  const byCommit = new Map<number, string>();
  for (const commit of commits) for (const n of taskNumbers(commit.subject)) if (!byCommit.has(n)) byCommit.set(n, commit.subject);
  const inStatus = new Set<number>();
  for (const line of (report?.status ?? "").split("\n")) if (/^#{1,6}\s/.test(line)) for (const n of taskNumbers(line)) inStatus.add(n);
  const inLog = taskNumbers(log);
  const placed = tasks.map((task): TaskProgress => {
    const commit = byCommit.get(task.number);
    if (commit) return { ...task, state: "committed", evidence: commit };
    if (inStatus.has(task.number)) return { ...task, state: "committed", evidence: "a section of the worker's STATUS.md" };
    if (inLog.has(task.number)) return { ...task, state: "started", evidence: "named in the worker's turn lines" };
    return { ...task, state: "unnamed", evidence: null };
  });
  return {
    tasks: placed,
    committed: placed.filter((task) => task.state === "committed").length,
    started: placed.filter((task) => task.state === "started").length,
    unnamed: placed.filter((task) => task.state === "unnamed").length,
    commits: commits.length,
  };
}

const list = (numbers: readonly number[]): string => numbers.map(String).join(", ");

/** The exit status of a process that ended on SIGTERM: 128 plus the signal's number. */
const SIGTERM_EXIT = 143;

/**
 * One line that says whether the build finished and how far it got: the
 * attempt's own state and exit, then the task count. "Finished" is the
 * worker ending on its own with an exit status of zero; whether what it
 * built is right is the supervisor's status and the person's review.
 */
export function progressHeadline(attempt: Pick<BuildAttempt, "state" | "outcome" | "endedBy">, progress: BuildProgress): string {
  const total = progress.tasks.length;
  const unnamed = progress.tasks.filter((task) => task.state === "unnamed").map((task) => task.number);
  const tally =
    total > 0
      ? `commits for ${String(progress.committed)} of ${String(total)} tasks${progress.started > 0 ? `, ${String(progress.started)} more named as under way` : ""}${unnamed.length > 0 && unnamed.length <= 8 ? `, and none yet for ${unnamed.length === 1 ? "task" : "tasks"} ${list(unnamed)}` : ""}`
      : `${String(progress.commits)} commit${progress.commits === 1 ? "" : "s"} (the plan has no numbered task list to count against)`;
  if (attempt.state === "running") return `Not finished. The worker is still working, with ${tally}.`;
  if (attempt.state === "detached") return `Not finished. The worker is still running from before the host restarted, with ${tally}.`;
  if (attempt.state === "lost") return `Not finished. The host was stopped and the worker is gone, leaving ${tally}. A new attempt can continue from its directory, below.`;
  if (attempt.state === "unavailable") return `Not started: the coding agent could not run.`;
  const outcome = attempt.outcome;
  if (!outcome) return `Ended, with ${tally}.`;
  // Who stopped it, when the host knows: the exit alone reads as a crash.
  if (attempt.endedBy === "host_stop") return `Not finished. The host was stopped while the worker was running, which ended it, leaving ${tally}. Nothing went wrong with the work; a new attempt can continue from its directory, below.`;
  if (attempt.endedBy === "cancel") return `Not finished. The attempt was cancelled, leaving ${tally}. A new attempt can continue from its directory, below.`;
  if (outcome.signal) return `Not finished. The attempt was ended by ${outcome.signal}, leaving ${tally}. A new attempt can continue from its directory, below.`;
  if (outcome.exitStatus === 0) {
    const all = total > 0 && progress.committed === total;
    return `${all ? "Finished" : "The worker finished"}: it exited 0 after ${String(outcome.turns ?? "?")} turns, with ${tally}. Whether the work is right is for the supervisor's status and your review.`;
  }
  // 143 is 128 + SIGTERM: the worker was told to stop and said so in its
  // exit, which a host that stopped before #781 recorded without the why.
  if (outcome.exitStatus === SIGTERM_EXIT) return `Not finished. The worker was told to stop (exit status 143, which is what a host stop or a cancel sends), leaving ${tally}. A new attempt can continue from its directory, below.`;
  return `Not finished. The worker stopped with exit status ${String(outcome.exitStatus ?? "?")}, leaving ${tally}. A new attempt can continue from its directory, below.`;
}

/** How many open items QUESTIONS.md lists: its top-level bullets. */
export function openQuestions(questions: string | null): number {
  if (!questions) return 0;
  return questions.split("\n").filter((line) => /^[-*]\s+\S/.test(line)).length;
}
