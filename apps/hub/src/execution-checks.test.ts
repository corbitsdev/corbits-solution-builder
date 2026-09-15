import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasWorkingDeliverable, runExecutionChecks } from "./execution-checks.js";

const workspaces: string[] = [];
afterEach(async () => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "execution-checks-test-"));
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
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "-c",
      "core.hooksPath=",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "chore: seed the workspace",
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  if (!commit.success) throw new Error(`seed commit failed: ${commit.stderr.toString()}`);
  return dir;
}

/** Writes and stages a further change over an existing seeded git workspace, without committing it — exactly what a worker's uncommitted edit looks like. */
async function writeOver(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

describe("runExecutionChecks vacuousness", () => {
  test("a seeded-but-empty workspace passes both checks, but neither is evidence of a deliverable", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({
        name: "empty",
        scripts: { test: "bun test", typecheck: "exit 0" },
      }),
    });

    const execution = await runExecutionChecks(workspace);

    expect(execution).toHaveLength(2);
    expect(execution.every((check) => check.ok)).toBe(true);
    expect(execution.every((check) => check.vacuous)).toBe(true);
    expect(hasWorkingDeliverable(execution)).toBe(false);
  });

  test("a seeded tsconfig and types/global.d.ts stub do not count as source: typecheck stays vacuous", async () => {
    // Exactly the shape the workspace seed writes so `tsc --noEmit` doesn't
    // hard-error on an empty project (TS18003) — a declaration file with no
    // logic in it, not a deliverable. Reproduces the real bug: this stub was
    // being counted as "source", so a build that wrote nothing still read
    // as complete.
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({
        name: "seeded-toolchain",
        scripts: { test: "bun test", typecheck: "exit 0" },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["apps", "packages", "types"] }),
      "types/global.d.ts": "export {};\n",
    });

    const execution = await runExecutionChecks(workspace);

    expect(execution.every((check) => check.ok)).toBe(true);
    expect(execution.every((check) => check.vacuous)).toBe(true);
    expect(hasWorkingDeliverable(execution)).toBe(false);
  });

  test("a typecheck script with real source files to typecheck is not vacuous", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "typed", scripts: { typecheck: "exit 0" } }),
      "src/index.ts": "export const x = 1;\n",
    });

    const execution = await runExecutionChecks(workspace);

    const typecheck = execution.find((check) => check.kind === "typecheck");
    expect(typecheck?.ok).toBe(true);
    expect(typecheck?.vacuous).toBe(false);
  });

  test("an entry point that runs and produces output is never vacuous, and is enough on its own", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({
        name: "runnable",
        scripts: { start: "bun run src/cli.ts", test: "bun test", typecheck: "exit 0" },
      }),
      "src/cli.ts": `console.log("hello");\n`,
    });

    const execution = await runExecutionChecks(workspace);

    const entry = execution.find((check) => check.kind === "entry_point");
    expect(entry?.ok).toBe(true);
    expect(entry?.vacuous).toBe(false);
    // The seeded test/typecheck scripts are still vacuous on their own, but
    // the entry point is real evidence, so overall this is a working deliverable.
    expect(hasWorkingDeliverable(execution)).toBe(true);
  });

  test("no discoverable check at all is never a working deliverable", () => {
    expect(hasWorkingDeliverable([])).toBe(false);
    expect(hasWorkingDeliverable(null)).toBe(false);
  });
});

describe("a seeded check the worker deleted", () => {
  test("a package.json that dropped the seeded typecheck script, with a passing test, must NOT be complete", async () => {
    const dir = await seededGitWorkspace({
      "package.json": JSON.stringify({
        name: "real-project",
        private: true,
        workspaces: ["apps/*"],
        scripts: { test: "bun test", typecheck: "tsc --noEmit" },
        devDependencies: { typescript: "^5.9.3" },
      }),
    });
    // Reproduces the real run: the worker replaced package.json wholesale,
    // keeping only `test`, and wrote no implementation at all.
    await writeOver(dir, { "package.json": JSON.stringify({ scripts: { test: "bun test" } }) });

    const execution = await runExecutionChecks(dir);

    const test = execution.find((check) => check.kind === "test");
    expect(test?.ok).toBe(true);
    expect(test?.vacuous).toBe(true);
    const typecheck = execution.find((check) => check.kind === "typecheck");
    expect(typecheck).toBeDefined();
    expect(typecheck?.ok).toBe(false);
    expect(typecheck?.detail).toContain("removed");
    expect(hasWorkingDeliverable(execution)).toBe(false);
  });

  test("a seeded script that moved into a workspace member's own package.json is not reported missing, and runs from there", async () => {
    const dir = await seededGitWorkspace({
      "package.json": JSON.stringify({
        name: "real-project",
        workspaces: ["apps/*"],
        scripts: { test: "bun test", typecheck: "tsc --noEmit" },
      }),
    });
    // The legitimate restructure: the deliverable became a workspace member
    // with its own manifest, and the root no longer declares `typecheck`.
    await writeOver(dir, {
      "package.json": JSON.stringify({ name: "real-project", workspaces: ["apps/*"], scripts: { test: "bun test" } }),
      "apps/icp-cli/package.json": JSON.stringify({ name: "icp-cli", scripts: { typecheck: "exit 0" } }),
      "apps/icp-cli/src/index.ts": "export const x = 1;\n",
    });

    const execution = await runExecutionChecks(dir);

    const typecheck = execution.find((check) => check.kind === "typecheck");
    expect(typecheck?.ok).toBe(true);
    // Real source under the member directory, not the seeded stub — not vacuous.
    expect(typecheck?.vacuous).toBe(false);
  });

  test("a host without git compares against nothing, rather than throwing", async () => {
    const dir = await workspaceWith({
      "package.json": JSON.stringify({ name: "no-git", scripts: { test: "bun test" } }),
    });

    const execution = await runExecutionChecks(dir);

    expect(execution.find((check) => check.kind === "typecheck")).toBeUndefined();
  });
});

describe("empty test files must not read as a passing suite", () => {
  test("N empty *.test.ts files: bun collects and runs them, executes zero tests, and that is vacuous", async () => {
    const dir = await workspaceWith({
      "package.json": JSON.stringify({ name: "empty-tests", scripts: { test: "bun test" } }),
      "src/__tests__/a.test.ts": "",
      "src/__tests__/b.test.ts": "",
      "src/__tests__/c.test.ts": "",
    });

    const execution = await runExecutionChecks(dir);

    const test = execution.find((check) => check.kind === "test");
    expect(test?.exitCode).toBe(0);
    expect(test?.ok).toBe(true);
    expect(test?.vacuous).toBe(true);
    expect(hasWorkingDeliverable(execution)).toBe(false);
  });
});

describe("the positive case: a real deliverable is complete", () => {
  test("a workspace member with a real entry point and real passing tests is a working deliverable", async () => {
    const dir = await workspaceWith({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
      "apps/icp-cli/package.json": JSON.stringify({
        name: "icp-cli",
        scripts: { start: "bun run src/cli.ts", test: "bun test", typecheck: "exit 0" },
      }),
      "apps/icp-cli/src/cli.ts": `console.log("icp-cli ready");\n`,
      "apps/icp-cli/src/__tests__/cli.test.ts":
        'import { test, expect } from "bun:test";\ntest("adds", () => { expect(1 + 1).toBe(2); });\n',
    });

    const execution = await runExecutionChecks(join(dir, "apps/icp-cli"));

    expect(execution.every((check) => check.ok)).toBe(true);
    const test = execution.find((check) => check.kind === "test");
    expect(test?.vacuous).toBe(false);
    const entry = execution.find((check) => check.kind === "entry_point");
    expect(entry?.ok).toBe(true);
    expect(hasWorkingDeliverable(execution)).toBe(true);
  });
});
