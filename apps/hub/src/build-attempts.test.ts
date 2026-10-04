import { describe, expect, test } from "bun:test";
import { assembleBuildPrompt, nextAttemptNumber } from "./build-attempts.js";
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

  test("a continued attempt is told the earlier work is in the directory", () => {
    const prompt = assembleBuildPrompt({ ...input, continuing: true });
    expect(prompt).toContain("An earlier attempt's work is already in the current directory");
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
