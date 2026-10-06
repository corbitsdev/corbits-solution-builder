import { describe, expect, test } from "bun:test";
import { openQuestions, planTasks, progressHeadline, taskNumbers, taskProgress } from "./build-progress.ts";
import type { BridgeOutcome } from "../../client.ts";

const PLAN = [
  "## Tasks in order",
  "",
  "Each task is for the coding agent; the time is the agent's.",
  "",
  "1. Repo scaffold: Bun workspace with `app/`, `workflows/`; lint and test runner. ~30 min. (NFR-1)",
  "2. App schema and migrations for the tables in Storage; `people.group` enum of four. ~45 min.",
  "3. Hub tenant bootstrap: agency principal. ~30 min.",
  "4. Sign-in route and screen with the FR-2 message. ~30 min. (FR-1)",
  "5. **Fetcher module** — denylist, robots.txt check. ~60 min.",
  "",
  "Total: roughly 17 hours.",
  "",
  "## Dependencies",
  "",
  "6. Not a task: this is in another section.",
].join("\n");

describe("planTasks", () => {
  test("reads the numbered tasks under 'Tasks in order' and nothing from other sections", () => {
    expect(planTasks(PLAN)).toEqual([
      { number: 1, title: "Repo scaffold" },
      { number: 2, title: "App schema and migrations for the tables in Storage; people.group enum of four" },
      { number: 3, title: "Hub tenant bootstrap" },
      { number: 4, title: "Sign-in route and screen with the FR-2 message" },
      { number: 5, title: "Fetcher module" },
    ]);
    expect(planTasks("# Plan\nno task list")).toEqual([]);
  });
});

describe("taskNumbers", () => {
  test("reads singles, ranges, pairs and lists, and ignores bare numbers", () => {
    expect([...taskNumbers("feat: seed script (Task 22)")]).toEqual([22]);
    expect([...taskNumbers("Shared modules (Tasks 5-8)")]).toEqual([5, 6, 7, 8]);
    expect([...taskNumbers("Tasks 5–8 done")]).toEqual([5, 6, 7, 8]);
    expect([...taskNumbers("Settings screen (Tasks 16 and 17)")]).toEqual([16, 17]);
    expect([...taskNumbers("STATUS for seed + deploy (Tasks 22, 24)")]).toEqual([22, 24]);
    expect([...taskNumbers("People screen (Tasks 12, 21-part)")]).toEqual([12, 21]);
    expect([...taskNumbers("Implement build-plan.md Tasks 16 and 17 — the Settings APIs")]).toEqual([16, 17]);
    expect([...taskNumbers("51 pass, 0 fail; AC-12")]).toEqual([]);
  });
});

describe("taskProgress and progressHeadline", () => {
  const tasks = planTasks(PLAN);
  const report = {
    commits: [
      { hash: "a", at: "2026-10-04T20:00:00Z", subject: "feat: scaffold and schema (Tasks 1-2)" },
      { hash: "b", at: "2026-10-04T20:30:00Z", subject: "docs: notes" },
    ],
    status: "# Build status\n\n## Hub bootstrap (Task 3)\n\nText mentioning Task 5 in prose does not count.\n",
    questions: "# Open product decisions\n\n- **Column count.** Confirm.\n- **Copy.** Confirm.\n  continued line\n",
  };
  const log = "── turn 9 · 1 tool call · 2.0s\n   spawn_agent {\"description\":\"Sign-in (Task 4)\"}\n";

  test("places each task by the worker's commits, STATUS.md headings, then turn lines", () => {
    const progress = taskProgress(tasks, report, log);
    expect(progress.tasks.map((task) => [task.number, task.state])).toEqual([
      [1, "committed"],
      [2, "committed"],
      [3, "committed"],
      [4, "started"],
      [5, "unnamed"],
    ]);
    expect(progress.tasks[0]!.evidence).toBe("feat: scaffold and schema (Tasks 1-2)");
    expect(progress.tasks[2]!.evidence).toBe("a section of the worker's STATUS.md");
    expect(progress).toMatchObject({ committed: 3, started: 1, unnamed: 1, commits: 2 });
    expect(taskProgress(tasks, null, "")).toMatchObject({ committed: 0, started: 0, unnamed: 5, commits: 0 });
  });

  const outcome = (over: Partial<BridgeOutcome>): BridgeOutcome => ({
    bridgeId: "b",
    worker: "corbits-code",
    command: "corbits",
    available: true,
    exitStatus: 0,
    signal: null,
    finalText: "",
    stderrTail: "",
    workspace: "/w",
    turnLog: null,
    turns: 135,
    toolCalls: 150,
    startedAt: "2026-10-04T19:42:21Z",
    endedAt: "2026-10-05T00:39:31Z",
    checkpointRef: null,
    ...over,
  });

  test("says not finished while running, finished on a clean exit, and how far either way", () => {
    const progress = taskProgress(tasks, report, log);
    expect(progressHeadline({ state: "running", outcome: null }, progress)).toBe("Not finished. The worker is still working, with commits for 3 of 5 tasks, 1 more named as under way, and none yet for task 5.");
    expect(progressHeadline({ state: "ended", outcome: outcome({}) }, progress)).toBe(
      "The worker finished: it exited 0 after 135 turns, with commits for 3 of 5 tasks, 1 more named as under way, and none yet for task 5. Whether the work is right is for the supervisor's status and your review.",
    );
    const all = taskProgress(tasks, { ...report, commits: [{ hash: "c", at: "", subject: "feat: all (Tasks 1-5)" }] }, "");
    expect(progressHeadline({ state: "ended", outcome: outcome({}) }, all)).toMatch(/^Finished: it exited 0 after 135 turns, with commits for 5 of 5 tasks\./);
    expect(progressHeadline({ state: "ended", outcome: outcome({ signal: "SIGTERM", exitStatus: null }) }, progress)).toMatch(/^Not finished\. The attempt was ended by SIGTERM, leaving commits for 3 of 5 tasks/);
    expect(progressHeadline({ state: "ended", outcome: outcome({ exitStatus: 1 }) }, progress)).toMatch(/^Not finished\. The worker stopped with exit status 1/);
    expect(progressHeadline({ state: "lost", outcome: null }, progress)).toMatch(/^Not finished\. The host was stopped/);
  });

  test("counts commits alone when the plan has no task list", () => {
    const progress = taskProgress([], report, "");
    expect(progressHeadline({ state: "running", outcome: null }, progress)).toBe("Not finished. The worker is still working, with 2 commits (the plan has no numbered task list to count against).");
  });

  test("counts the open questions as top-level bullets", () => {
    expect(openQuestions(report.questions)).toBe(2);
    expect(openQuestions(null)).toBe(0);
  });
});

// #777: a plan that lays its tasks out as a table, and the short T-number form.
describe("task tables and T-numbers", () => {
  test("reads `| T1 | … |` rows under 'Tasks in order'", () => {
    const plan = ["## Tasks in order", "", "| # | Task | Done when |", "|---|---|---|", "| T1 | Scaffold bun workspace; lint | Applies |", "| T2 | `deploy/`: compose for dev | Boots |", "", "## Dependencies"].join("\n");
    expect(planTasks(plan)).toEqual([
      { number: 1, title: "Scaffold bun workspace; lint" },
      { number: 2, title: "deploy/" },
    ]);
  });

  test("T36, T36–T37 and T1-T28 name tasks", () => {
    expect([...taskNumbers("Web T36 (finish): approvals screens")]).toEqual([36]);
    expect([...taskNumbers("the T36–T37 successor")]).toEqual([36, 37]);
    expect([...taskNumbers("Tasks T1-T3 committed")]).toEqual([1, 2, 3]);
  });
});
