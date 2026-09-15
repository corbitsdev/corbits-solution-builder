import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeCompletion, parseVerdict } from "./completion-judge.js";
import type { CompletionResult, CompletionRequest } from "./inference.js";

const workspaces: string[] = [];
afterEach(async () => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "completion-judge-test-"));
  workspaces.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

/** Writes `files` into a fresh git repo and commits them as the seed's own baseline would. */
async function seededGitWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await workspaceWith(files);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const commit = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "chore: seed the workspace"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  if (!commit.success) throw new Error(`seed commit failed: ${commit.stderr.toString()}`);
  return dir;
}

async function writeOver(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

/** A `completeFn` stand-in that never talks to a provider: records what it was asked and returns a canned answer. */
function stubCompleteFn(answer: () => CompletionResult) {
  const prompts: string[] = [];
  const fn = async (request: CompletionRequest): Promise<CompletionResult> => {
    prompts.push(request.prompt);
    return answer();
  };
  return { fn, prompts };
}

const NEVER_CALLED = async (): Promise<CompletionResult> => {
  throw new Error("the judge should not have been asked: the mechanical ceiling alone was decisive");
};

describe("parseVerdict", () => {
  test("reads a clean JSON verdict", () => {
    expect(parseVerdict('{"level": "high", "reasoning": "it works"}')).toEqual({ level: "high", reasoning: "it works" });
  });

  test("reads a verdict wrapped in prose or fences", () => {
    expect(parseVerdict('Here is my answer:\n```json\n{"level": "low", "reasoning": "barely started"}\n```')).toEqual({
      level: "low",
      reasoning: "barely started",
    });
  });

  test("rejects a reply with no reasoning, an invalid level, or a missing level", () => {
    expect(parseVerdict('{"level": "high"}')).toBeNull();
    expect(parseVerdict('{"level": "certainly", "reasoning": "sure"}')).toBeNull();
    expect(parseVerdict('{"level": "high", "reasoning": ""}')).toBeNull();
    expect(parseVerdict("not json at all")).toBeNull();
  });
});

describe("mechanical ceiling: below 'medium' the judge is never asked", () => {
  test("no runnable entry point at all: level 'none', judge not called", async () => {
    const workspace = await workspaceWith({});

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    expect(verdict.level).toBe("none");
    expect(verdict.source).toBe("mechanical");
    expect(verdict.targets).toHaveLength(1);
    expect(verdict.targets[0]?.exercised).toBe(false);
  });

  test("an entry point that runs but prints nothing: level 'low', judge not called", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "silent", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": "// does nothing\n",
    });

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    expect(verdict.level).toBe("low");
    expect(verdict.source).toBe("mechanical");
    expect(verdict.targets[0]?.ranSuccessfully).toBe(true);
    expect(verdict.targets[0]?.producedOutput).toBe(false);
  });
});

describe("the five reported false-complete cases: every one stays below 'high', without needing the worker's own tests trusted", () => {
  test("case 1 — seeded test/typecheck pass trivially on an empty workspace: no entry point, level 'none'", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "empty", scripts: { test: "bun test", typecheck: "exit 0" } }),
    });

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    expect(verdict.level).toBe("none");
    expect(verdict.checks.every((check) => check.ok && check.vacuous)).toBe(true);
  });

  test("case 2 — the seeded types/global.d.ts stub does not create an entry point either: level 'none'", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "seeded-toolchain", scripts: { test: "bun test", typecheck: "exit 0" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["apps", "packages", "types"] }),
      "types/global.d.ts": "export {};\n",
    });

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    expect(verdict.level).toBe("none");
  });

  test("case 3 — a deleted seeded script clamps the ceiling to 'medium' even when real input was fed and the judge says 'high'", async () => {
    const dir = await seededGitWorkspace({
      "package.json": JSON.stringify({
        name: "real-project",
        scripts: { start: "bun run src/cli.ts", test: "bun test", typecheck: "tsc --noEmit" },
      }),
      "src/cli.ts": `for await (const line of console) { console.log("echo: " + line); }\n`,
    });
    await writeOver(dir, { "package.json": JSON.stringify({ scripts: { start: "bun run src/cli.ts", test: "bun test" } }) });
    const requirements = ["## Example", "You: hello"].join("\n");
    const { fn, prompts } = stubCompleteFn(() => ({
      text: '{"level": "high", "reasoning": "it echoed the input back"}',
      providerId: "x",
      model: "x",
      inputTokens: null,
      outputTokens: null,
    }));

    const verdict = await judgeCompletion({ workspaceRoot: dir, plan: "plan", requirements }, fn);

    // Real input was fed and the entry point produced output — the ceiling
    // would otherwise be "high" — but the deleted seeded `typecheck` script
    // is a structural red flag that caps it at "medium" regardless of what
    // the judge itself answered.
    expect(prompts).toHaveLength(1);
    expect(verdict.targets[0]?.realInputFed).toBe(true);
    expect(verdict.level).not.toBe("high");
    expect(verdict.level).toBe("medium");
  });

  test("case 4 — empty *.test.ts files with no entry point: level 'none', regardless of the passing (vacuous) test check", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "empty-tests", scripts: { test: "bun test" } }),
      "src/__tests__/a.test.ts": "",
      "src/__tests__/b.test.ts": "",
      "src/__tests__/c.test.ts": "",
    });

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    const test = verdict.checks.find((check) => check.kind === "test");
    expect(test?.ok).toBe(true);
    expect(test?.vacuous).toBe(true);
    expect(verdict.level).toBe("none");
  });

  test("case 5 — the residual gap: empty test files read as typecheckable source, so typecheck alone is (wrongly) non-vacuous — still 'none' because nothing was ever run", async () => {
    // Reproduces the real run: bunfig.json and two ~165-byte test files, no
    // implementation at all, no entry point. `test` is honestly vacuous
    // (bun ran 0 tests), but `typecheck` is declared too, and the same empty
    // *.test.ts files count as "source" for it (SOURCE_FILE_PATTERN excludes
    // only `.d.ts`) — the check-level vacuousness rule alone still calls it
    // non-vacuous. It does not matter: with no entry point, the level is
    // "none" regardless of what the checks report.
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "case5", scripts: { test: "bun test", typecheck: "exit 0" } }),
      "src/__tests__/a.test.ts": "",
      "src/__tests__/b.test.ts": "",
    });

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    const typecheck = verdict.checks.find((check) => check.kind === "typecheck");
    expect(typecheck?.vacuous).toBe(false);
    expect(verdict.level).toBe("none");
  });
});

describe("real input drawn from the requirements", () => {
  test("a requirements 'Example' section feeds real lines to the CLI's stdin, and the judge sees them", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "echoer", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `
        for await (const line of console) {
          console.log("you said: " + line);
        }
      `,
    });
    const requirements = [
      "# Requirements",
      "The tool must greet the user.",
      "",
      "## Example session",
      "You: hello there",
      "You: what's my ICP",
    ].join("\n");
    const { fn, prompts } = stubCompleteFn(() => ({
      text: '{"level": "medium", "reasoning": "it echoed back the input"}',
      providerId: "x",
      model: "x",
      inputTokens: null,
      outputTokens: null,
    }));

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements }, fn);

    expect(verdict.targets[0]?.realInputFed).toBe(true);
    expect(verdict.targets[0]?.transcript).toContain("hello there");
    expect(verdict.targets[0]?.transcript).toContain("what's my ICP");
    expect(prompts[0]).toContain("hello there");
    expect(verdict.level).toBe("medium");
  });

  test("no example section in the requirements: fed no input, honestly says so, still exercises the entry point", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "silent-start", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `console.log("started");\n`,
    });
    const { fn } = stubCompleteFn(() => ({
      text: '{"level": "medium", "reasoning": "it started and printed something, but nothing was exercised"}',
      providerId: "x",
      model: "x",
      inputTokens: null,
      outputTokens: null,
    }));

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "no example here" }, fn);

    expect(verdict.targets[0]?.realInputFed).toBe(false);
    expect(verdict.targets[0]?.transcript).toContain("no example input was found");
    expect(verdict.level).toBe("medium");
  });
});

describe("declared targets select the modality; an unimplemented one never blocks and never falsely passes", () => {
  test("a 'web' target is honestly reported as not exercised, and contributes no confidence, but does not block the build", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "web-thing", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `console.log("hello");\n`,
    });

    const verdict = await judgeCompletion(
      { workspaceRoot: workspace, plan: "plan", requirements: "reqs", targets: ["web app"] },
      NEVER_CALLED,
    );

    expect(verdict.targets).toHaveLength(1);
    expect(verdict.targets[0]?.modality).toBe("web");
    expect(verdict.targets[0]?.exercised).toBe(false);
    // Not exercised is not a failure and not a block: the loop is free to
    // keep going or stop on other grounds. Here nothing else was exercised
    // either, so the ceiling reads "none" rather than refusing outright.
    expect(verdict.level).toBe("none");
  });

  test("no targets declared defaults to a single implicit 'cli' target", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "default-target", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `console.log("hello");\n`,
    });

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, NEVER_CALLED);

    expect(verdict.targets).toEqual([expect.objectContaining({ target: "cli", modality: "cli" })]);
  });
});

describe("the positive case: real behaviour reaches the judge and can be rated 'high'", () => {
  test("an entry point driven with real input, matching the requirements per the judge, is rated 'high'", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "icp-cli", scripts: { start: "bun run src/cli.ts", test: "bun test", typecheck: "exit 0" } }),
      "src/cli.ts": `
        for await (const line of console) {
          console.log("ICP proposal based on: " + line);
        }
      `,
      "src/__tests__/cli.test.ts": 'import { test, expect } from "bun:test";\ntest("adds", () => { expect(1 + 1).toBe(2); });\n',
    });
    const requirements = ["## Sample interaction", "You: we sell to mid-market fintech ops teams"].join("\n");
    const { fn, prompts } = stubCompleteFn(() => ({
      text: '{"level": "high", "reasoning": "it produced an ICP proposal from the fed input, matching the requirements"}',
      providerId: "x",
      model: "x",
      inputTokens: null,
      outputTokens: null,
    }));

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements }, fn);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("SELF-REPORTED");
    expect(verdict.level).toBe("high");
    expect(verdict.source).toBe("judge");
  });

  test("the judge can still downgrade a 'medium'/'high'-eligible run when the behaviour does not match the requirements", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "stub-cli", scripts: { start: "bun run src/cli.ts" } }),
      // Runs, produces output, but is not a real implementation of anything
      // — exactly the "trivial entry point" false positive the old
      // execution-checks.ts rule treated as "enough on its own".
      "src/cli.ts": `console.log("done");\n`,
    });
    const { fn } = stubCompleteFn(() => ({
      text: '{"level": "none", "reasoning": "it only prints a static string; nothing in the transcript resembles the requirements"}',
      providerId: "x",
      model: "x",
      inputTokens: null,
      outputTokens: null,
    }));

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, fn);

    expect(verdict.level).toBe("none");
    expect(verdict.source).toBe("judge");
  });
});

describe("judge failure never raises the level", () => {
  test("a provider failure holds the level at the mechanical ceiling and says why", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "x", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `console.log("hello");\n`,
    });
    const failing = async (): Promise<CompletionResult> => {
      throw new Error("No inference connection is ready.");
    };

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, failing);

    expect(verdict.level).not.toBe("high");
    expect(verdict.source).toBe("unavailable");
    expect(verdict.reasoning).toContain("No inference connection is ready");
  });

  test("an unparseable answer holds the level at the mechanical ceiling, not a guess", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "x", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `console.log("hello");\n`,
    });
    const { fn } = stubCompleteFn(() => ({
      text: "Sure, looks done to me!",
      providerId: "x",
      model: "x",
      inputTokens: null,
      outputTokens: null,
    }));

    const verdict = await judgeCompletion({ workspaceRoot: workspace, plan: "plan", requirements: "reqs" }, fn);

    expect(verdict.level).not.toBe("high");
    expect(verdict.source).toBe("unavailable");
  });
});
