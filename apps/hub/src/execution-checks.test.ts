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
