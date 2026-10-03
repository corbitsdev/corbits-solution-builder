import { describe, expect, test } from "bun:test";
import { BUILD_WORKERS, DEFAULT_BUILD_WORKER, hostPlatform, installInstruction, workerKind } from "./build-worker.js";

describe("the build worker registry", () => {
  test("Corbits Code is first and the default, with Claude Code and Codex after it", () => {
    expect(BUILD_WORKERS.map((worker) => worker.id)).toEqual(["corbits-code", "claude-code", "codex"]);
    expect(DEFAULT_BUILD_WORKER).toBe("corbits-code");
    expect(workerKind("not-a-worker").id).toBe("corbits-code");
  });

  test("each worker takes the packet by stdin or by file, never as one argument, and never a permission-skipping flag", () => {
    for (const worker of BUILD_WORKERS) {
      for (const arg of worker.prompt.args) {
        expect(arg).not.toMatch(/skip-permissions|yolo|full-auto|bypass/i);
      }
    }
    const corbits = workerKind("corbits-code").prompt;
    expect(corbits.via).toBe("file");
    if (corbits.via === "file") {
      expect(corbits.path).toBe(".corbits/solution-builder-prompt.md");
      expect(corbits.args[0]).toBe("exec");
      expect(corbits.args[1]).toContain(corbits.path);
    }
    expect(workerKind("claude-code").prompt).toEqual({ via: "stdin", args: ["-p"] });
    expect(workerKind("codex").prompt).toEqual({ via: "stdin", args: ["exec", "-"] });
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

  test("Corbits Code comes from the Homebrew tap on macOS and Linux, with the release tarball and the .deb as alternatives", () => {
    const releases = "https://github.com/corbitsdev/corbits-code/releases/latest";
    const macos = installInstruction(workerKind("corbits-code"), "macos");
    expect(macos.binary).toBe("corbits");
    expect(macos.command).toBe("brew install corbitsdev/tap/corbits-code");
    expect(macos.url).toBe(releases);
    expect(macos.verified).toBe(true);
    expect(macos.text).toContain("macOS tarball");
    expect(macos.text).not.toContain("npm");
    expect(macos.text).not.toContain("unverified");

    const linux = installInstruction(workerKind("corbits-code"), "linux");
    expect(linux.command).toBe("brew install corbitsdev/tap/corbits-code");
    expect(linux.text).toContain("sudo dpkg -i corbits_<version>_<arch>.deb");
    expect(linux.text).toContain("Linux tarball");
  });

  test("Corbits Code is not published for Windows, and the instruction says so instead of inventing a command", () => {
    const windows = installInstruction(workerKind("corbits-code"), "windows");
    expect(windows.command).toBeNull();
    expect(windows.url).toBe("https://github.com/corbitsdev/corbits-code/releases/latest");
    expect(windows.verified).toBe(true);
    expect(windows.text).toContain("not published for Windows");
    expect(windows.text).toContain("Claude Code or Codex");
  });
});
