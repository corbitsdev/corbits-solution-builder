import { describe, expect, test } from "bun:test";
import { assembleBuildPrompt, nextAttemptNumber, parseGitLog, workspaceReportAt } from "./build-attempts.js";
import { mkdir, mkdtemp, writeFile as writeFileAsync, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { safeWorkspacePath } from "./build-attempts.js";
import { CONTINUE_EXCLUDES } from "./corbits-exec.js";

describe("nextAttemptNumber", () => {
  test("the first attempt is 1", () => {
    expect(nextAttemptNumber([])).toBe(1);
  });

  test("one past the highest numbered directory, ignoring anything else in the folder", () => {
    expect(nextAttemptNumber(["1", "2", "3"])).toBe(4);
    expect(nextAttemptNumber(["3", "1"])).toBe(4);
    expect(nextAttemptNumber(["2", "2.log", "2.json", "2.prompt.txt", "notes"])).toBe(3);
  });

  test("a gap is not filled: a deleted attempt's number is never reused", () => {
    expect(nextAttemptNumber(["1", "5"])).toBe(6);
  });
});

describe("assembleBuildPrompt", () => {
  const input = {
    planText: "# Plan\nBuild the thing.",
    requirementsText: "# Requirements\nR1 it works.",
    designText: "# Design\nOne page.",
    stackBlock: "## Stack\n- bun",
    target: "web",
    planRef: "art_plan@3",
    continuing: false,
  };

  test("leads with the instruction, then the frozen stack, requirements, design and plan, and names the plan and target", () => {
    const prompt = assembleBuildPrompt(input);
    const order = ["Build the software described by this approved plan", "--- STACK", "## Stack", "--- REQUIREMENTS ---", "R1 it works.", "--- DESIGN ---", "One page.", "--- PLAN ---", "Build the thing.", "Approved plan: art_plan@3.", "Target: web."];
    let last = -1;
    for (const part of order) {
      const at = prompt.indexOf(part);
      expect({ part, found: at >= 0 }).toEqual({ part, found: true });
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(prompt).not.toContain("earlier attempt");
  });

  test("states the two documents every build ships, in the workspace's language", () => {
    expect(assembleBuildPrompt(input)).toContain("Every build ships two documents, written in American English.");
    expect(assembleBuildPrompt(input)).toContain("README.md, at the top level, is for the person who installs and runs the application");
    expect(assembleBuildPrompt(input)).toContain("docs/USER-MANUAL.md is for the people who use the application");
    expect(assembleBuildPrompt({ ...input, language: "British English" })).toContain("written in British English.");
    expect(assembleBuildPrompt(input)).toContain("has a shebang line and its executable bit set");
  });

  test("asks for a progress record the page can read: task numbers in commits and STATUS.md", () => {
    const prompt = assembleBuildPrompt(input);
    expect(prompt).toContain('Name the plan task every commit is for in its subject, as "(Task N)"');
    expect(prompt).toContain("Keep STATUS.md at the root");
  });

  test("a continued attempt is told the earlier work is in the directory", () => {
    const prompt = assembleBuildPrompt({ ...input, continuing: true });
    expect(prompt).toContain("An earlier attempt's work is already in the current directory");
    expect(prompt).not.toContain("WHAT THE PERSON FOUND");
    // #789: the person's note to the worker rides in the continuation packet, ahead of the plan.
    const noted = assembleBuildPrompt({ ...input, continuing: true, continueNote: "  The dev instructions never build the web bundle, so / is a 404.\n" });
    const section = noted.indexOf("--- WHAT THE PERSON FOUND IN THE EARLIER ATTEMPT ---\nThe dev instructions never build the web bundle, so / is a 404.\n\nDo what this asks before anything else");
    expect(section).toBeGreaterThan(noted.indexOf("Continue from it"));
    expect(section).toBeLessThan(noted.indexOf("--- PLAN ---"));
    // A note on a fresh start is not a continuation and is not sent; a blank one is nothing.
    expect(assembleBuildPrompt({ ...input, continuing: false, continueNote: "fix it" })).not.toContain("WHAT THE PERSON FOUND");
    expect(assembleBuildPrompt({ ...input, continuing: true, continueNote: "   " })).not.toContain("WHAT THE PERSON FOUND");
    expect(prompt).toContain("do not start over");
  });

  test("an empty section is left out rather than written as an empty heading", () => {
    const prompt = assembleBuildPrompt({ ...input, requirementsText: "", designText: "", stackBlock: "", planRef: "", target: "" });
    expect(prompt).not.toContain("--- REQUIREMENTS ---");
    expect(prompt).not.toContain("--- DESIGN ---");
    expect(prompt).not.toContain("--- STACK");
    expect(prompt).toContain("--- PLAN ---");
    expect(prompt).toContain("Approved plan: unknown.");
    expect(prompt).toContain("Target: unknown.");
  });

  test("the same input assembles the same prompt: the packet is a function of the frozen material", () => {
    expect(assembleBuildPrompt(input)).toBe(assembleBuildPrompt({ ...input }));
  });
});

describe("a continued attempt's copy", () => {
  test("leaves out installed dependencies, build caches and the bridge's hook, and keeps .git", () => {
    for (const name of ["node_modules", ".corbits", "dist", ".next", ".turbo", ".cache", "coverage", ".venv", "__pycache__"]) {
      expect(CONTINUE_EXCLUDES.has(name)).toBe(true);
    }
    expect(CONTINUE_EXCLUDES.has(".git")).toBe(false);
    expect(CONTINUE_EXCLUDES.has("src")).toBe(false);
  });
});

// #686: seeded files stay inside the workspace, and the prompt names them.
describe("seeded workspace files", () => {
  test("a relative path is fine; absolute, parent-walking or empty paths are refused", () => {
    expect(safeWorkspacePath("AGENTS.md")).toBe(true);
    expect(safeWorkspacePath("docs/design.html")).toBe(true);
    expect(safeWorkspacePath("/etc/passwd")).toBe(false);
    expect(safeWorkspacePath("../outside.md")).toBe(false);
    expect(safeWorkspacePath("a/../../b")).toBe(false);
    expect(safeWorkspacePath("")).toBe(false);
  });

  test("the prompt tells the worker to read AGENTS.md first when files are seeded", () => {
    const prompt = assembleBuildPrompt({ planText: "plan", requirementsText: "", designText: "", stackBlock: "", target: "web", planRef: "a@1", continuing: false, files: [{ path: "AGENTS.md", content: "x" }, { path: "build-plan.md", content: "plan" }] });
    expect(prompt).toContain("as files: AGENTS.md, build-plan.md. Read AGENTS.md first");
  });
});

// #697: the progress record is read out of the directory, never inferred.
describe("workspace report", () => {
  test("parses git log lines into commits, oldest first, keeping tabs inside a subject", () => {
    expect(parseGitLog("abc\t2026-10-05T00:35:00+01:00\tfeat: seed (Task 22)\ndef\t2026-10-05T00:36:00+01:00\tdocs: a\tb\n")).toEqual([
      { hash: "abc", at: "2026-10-05T00:35:00+01:00", subject: "feat: seed (Task 22)" },
      { hash: "def", at: "2026-10-05T00:36:00+01:00", subject: "docs: a\tb" },
    ]);
    expect(parseGitLog("")).toEqual([]);
  });

  test("reads STATUS.md and QUESTIONS.md and the repository's commits from a directory", async () => {
    const directory = await mkdtemp(joinPath(tmpdir(), "sb-report-"));
    try {
      await writeFileAsync(joinPath(directory, "STATUS.md"), "# Build status\n\n## Task 1: scaffold\n");
      const git = async (...args: string[]) => {
        const run = Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
        await run.exited;
      };
      await git("init", "-q");
      await git("add", "STATUS.md");
      await git("commit", "-q", "-m", "feat: scaffold (Task 1)");
      await mkdir(joinPath(directory, "docs", "manual"), { recursive: true });
      await writeFileAsync(joinPath(directory, "docs", "USER-MANUAL.md"), "# Using it\n");
      await writeFileAsync(joinPath(directory, "docs", "manual", "people.png"), "png");
      await writeFileAsync(joinPath(directory, "docs", "manual", "notes.txt"), "not a picture");
      const report = await workspaceReportAt(directory);
      expect(report.status).toContain("## Task 1: scaffold");
      expect(report.questions).toBeNull();
      expect(report.documents).toEqual({ readme: false, userManual: true, manualImages: 1 });
      expect(report.commits.map((commit) => commit.subject)).toEqual(["feat: scaffold (Task 1)"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a directory without a repository reports no commits rather than failing", async () => {
    const directory = await mkdtemp(joinPath(tmpdir(), "sb-report-"));
    try {
      expect(await workspaceReportAt(directory)).toEqual({ commits: [], status: null, questions: null, documents: { readme: false, userManual: false, manualImages: 0 } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
