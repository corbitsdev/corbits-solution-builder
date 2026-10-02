import { describe, expect, test } from "bun:test";
import { BUILD_WORKERS, DEFAULT_BUILD_WORKER, hostPlatform, installInstruction, workerKind } from "./build-worker.js";

describe("the build worker registry", () => {
  test("Corbits Code is first and the default, with Claude Code and Codex after it", () => {
    expect(BUILD_WORKERS.map((worker) => worker.id)).toEqual(["corbits-code", "claude-code", "codex"]);
    expect(DEFAULT_BUILD_WORKER).toBe("corbits-code");
    expect(workerKind("not-a-worker").id).toBe("corbits-code");
  });

  test("each worker runs its non-interactive form and never a permission-skipping flag", () => {
    for (const worker of BUILD_WORKERS) {
      const args = worker.run("build it");
      expect(args).toContain("build it");
      for (const arg of args) {
        expect(arg).not.toMatch(/skip-permissions|yolo|full-auto|bypass/i);
      }
    }
    expect(workerKind("corbits-code").run("p")).toEqual(["exec", "p"]);
    expect(workerKind("claude-code").run("p")).toEqual(["-p", "p"]);
    expect(workerKind("codex").run("p")).toEqual(["exec", "p"]);
  });

  test("only Corbits Code places a turn hook, and the hook reads every other payload to its end", () => {
    const corbits = workerKind("corbits-code");
    const files = corbits.turnReports!.install("/tmp/it's a log");
    expect(files.map((file) => file.path)).toEqual([".corbits/hooks/solution-builder-turns.sh", ".corbits/hooks/.gitignore"]);
    expect(files[0]!.content).toContain("postTurn) cat >> '/tmp/it'\\''s a log'");
    expect(files[0]!.content).toContain("*) cat > /dev/null");
    expect(workerKind("claude-code").turnReports).toBeNull();
    expect(workerKind("codex").turnReports).toBeNull();
  });
});

describe("hostPlatform", () => {
  test("names the three operating systems the instruction is written for", () => {
    expect(hostPlatform("darwin")).toBe("macos");
    expect(hostPlatform("win32")).toBe("windows");
    expect(hostPlatform("linux")).toBe("linux");
    expect(hostPlatform("freebsd")).toBe("linux");
  });
});

describe("installInstruction", () => {
  test("an npm-published worker gets an install command, on every platform", () => {
    for (const platform of ["macos", "linux", "windows"] as const) {
      const claude = installInstruction(workerKind("claude-code"), platform);
      expect(claude.binary).toBe("claude");
      expect(claude.command).toBe("npm install -g @anthropic-ai/claude-code");
      expect(claude.verified).toBe(true);
      expect(claude.text).toContain("`claude` was not found");
      expect(claude.text).toContain(claude.command!);
      const codex = installInstruction(workerKind("codex"), platform);
      expect(codex.command).toBe("npm install -g @openai/codex");
    }
  });

  test("the text names the host's operating system and where to type the command", () => {
    expect(installInstruction(workerKind("codex"), "macos").text).toContain("macOS");
    expect(installInstruction(workerKind("codex"), "macos").text).toContain("brew install node");
    expect(installInstruction(workerKind("codex"), "linux").text).toContain("Linux");
    expect(installInstruction(workerKind("codex"), "windows").text).toContain("Windows");
    expect(installInstruction(workerKind("codex"), "windows").text).toContain("PowerShell");
  });

  test("Corbits Code, absent from npm, gets its repository as an unverified pointer and no command", () => {
    const instruction = installInstruction(workerKind("corbits-code"), "linux");
    expect(instruction.binary).toBe("corbits");
    expect(instruction.command).toBeNull();
    expect(instruction.url).toBe("https://github.com/corbitsdev/corbits-code");
    expect(instruction.verified).toBe(false);
    expect(instruction.text).toContain("not published on npm");
    expect(instruction.text).toContain("unverified");
  });
});
