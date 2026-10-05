import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTargetProbe, publishWorkspaceTool, TOOL_NAME, type DeliveryManifestContent } from "./publish-workspace.js";

describe("parseTargetProbe", () => {
  test("keeps a target that says how it starts and where it listens", () => {
    expect(parseTargetProbe({ target: "web", command: ["bun", "run", "start"], port: 3000 })).toEqual({ target: "web", command: ["bun", "run", "start"], port: 3000, routes: [] });
    expect(parseTargetProbe({ target: "api", command: "bun src/server.ts", port: 8080, routes: ["/health", "nope"], path: "/" })).toEqual({
      target: "api",
      command: ["sh", "-c", "bun src/server.ts"],
      port: 8080,
      routes: ["/health"],
      path: "/",
    });
  });

  test("drops a target it could not run rather than guessing", () => {
    expect(parseTargetProbe({ target: "web", port: 3000 })).toBeNull();
    expect(parseTargetProbe({ target: "web", command: [], port: 3000 })).toBeNull();
    expect(parseTargetProbe({ target: "web", command: ["x"], port: 0 })).toBeNull();
    expect(parseTargetProbe({ target: "web", command: ["x"], port: "3000" })).toBeNull();
    expect(parseTargetProbe({ command: ["x"], port: 3000 })).toBeNull();
    expect(parseTargetProbe("web")).toBeNull();
  });
});

/** A workspace with one attempt, and no `hub` credential: the fallback path. */
async function fixtureWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "sb-publish-"));
  const attempt = join(cwd, "attempts", "2");
  await mkdir(join(attempt, "src"), { recursive: true });
  await mkdir(join(cwd, "attempts", "1"), { recursive: true });
  await mkdir(join(attempt, "node_modules", "dep"), { recursive: true });
  await writeFile(join(attempt, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(join(attempt, "README.md"), "# fixture\n");
  await mkdir(join(attempt, "docs"), { recursive: true });
  await writeFile(join(attempt, "docs", "USER-MANUAL.md"), "# Using it\n");
  await writeFile(join(attempt, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await mkdir(join(attempt, ".corbits", "hooks"), { recursive: true });
  await writeFile(join(attempt, ".corbits", "hooks", "solution-builder-turns.sh"), "#!/bin/sh\n");
  await writeFile(
    join(attempt, "server.ts"),
    `Bun.serve({ port: Number(process.env.FIXTURE_PORT), fetch: () => new Response("<html><body>ok</body></html>", { headers: { "content-type": "text/html" } }) });\n`,
  );
  return cwd;
}

function fallbackEnv(toolCwd: string) {
  return {
    toolCwd,
    address: "run_1@proj.localhost",
    capabilities: {
      resolve: () => {
        throw new Error("no credential capability in this test");
      },
    },
  } as never;
}

type FallbackResult = {
  fallback: "data-uri";
  fileName: string;
  sizeBytes: number;
  dataUri: string;
  manifest: DeliveryManifestContent;
  verification: { complete: boolean; failed: string[]; targets: { target: string; ranSuccessfully: boolean; transcript: string }[] };
};

describe("publish_workspace (fallback path)", () => {
  test("archives the current attempt, checks the archive against its own manifest, and probes the target it is told about", async () => {
    const cwd = await fixtureWorkspace();
    try {
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const tool = publishWorkspaceTool()(fallbackEnv(cwd));
      const result = await tool.run(
        {
          id: "1",
          name: TOOL_NAME,
          arguments: { targets: [{ target: "web", command: `FIXTURE_PORT=${String(port)} exec bun server.ts`, port }] },
        },
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content as string) as FallbackResult;
      expect(parsed.fallback).toBe("data-uri");
      expect(parsed.dataUri.startsWith("data:application/gzip;base64,")).toBe(true);

      const { manifest } = parsed;
      expect(manifest.attempt).toBe("attempt-2");
      // The bridge's hook directory is the host's plumbing, never shipped or listed.
      expect(manifest.files.map((file) => file.path)).toEqual(["README.md", "docs/USER-MANUAL.md", "server.ts", "src/index.ts"]);
      expect(manifest.archive.sizeBytes).toBe(parsed.sizeBytes);

      const verification = manifest.verification!;
      expect(verification.checkedBy).toBe("tool");
      expect(verification.report.manifestNodeId).toBe(`sha256:${manifest.archive.sha256}`);
      expect(verification.items.map((item) => [item.path, item.status, item.checkedBy])).toEqual([
        ["README.md", "verified", "tool"],
        ["docs/USER-MANUAL.md", "verified", "tool"],
        ["server.ts", "verified", "tool"],
        ["src/index.ts", "verified", "tool"],
        // The two documents every build ships, checked on the archive itself.
        ["README.md", "verified", "tool"],
        ["docs/USER-MANUAL.md", "verified", "tool"],
        ["target:web", "verified", "tool"],
      ]);
      expect(verification.targets[0]?.transcript).toContain("port " + String(port) + " opened.");
      expect(verification.report.complete).toBe(true);
      expect(parsed.verification).toEqual({ complete: true, failed: [], targets: [{ target: "web", ranSuccessfully: true, transcript: verification.targets[0]!.transcript }] });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("with no targets named, nothing is probed and the manifest says so", async () => {
    const cwd = await fixtureWorkspace();
    try {
      const tool = publishWorkspaceTool()(fallbackEnv(cwd));
      const result = await tool.run({ id: "2", name: TOOL_NAME, arguments: {} }, new AbortController().signal);
      const parsed = JSON.parse(result.content as string) as FallbackResult;
      expect(parsed.manifest.verification?.targets).toEqual([]);
      expect(parsed.manifest.verification?.items.every((item) => item.status === "verified" && item.checkedBy === "tool")).toBe(true);
      expect(parsed.verification.targets).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
