import { describe, test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryDescriptor, DeliveryManifest } from "@solutions-builder/app/delivery";
import { verifyManifest } from "./delivery.js";

const workspaces: string[] = [];

afterEach(async () => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "delivery-verify-test-"));
  workspaces.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

async function descriptorFor(workspaceRoot: string, path: string): Promise<DeliveryDescriptor> {
  const full = join(workspaceRoot, path);
  const bytes = await Bun.file(full).bytes();
  const info = await stat(full);
  return {
    category: "source",
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: info.size,
    mediaType: "application/octet-stream",
    access: "local",
    required: true,
  };
}

function manifestOf(descriptors: DeliveryDescriptor[]): DeliveryManifest {
  return { descriptors, costForecast: null, costActual: null, costActualReason: null };
}

describe("verifyManifest execution checks", () => {
  test("a stub deliverable does not verify, even though its files exist", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "stub", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `async function main() {\n  const matches: unknown[] = [];\n  return matches;\n}\nexport default main;\n`,
    });
    const manifest = manifestOf([await descriptorFor(workspace, "src/cli.ts")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.items.every((item) => item.status === "verified")).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.failed).toContain("execution:entry_point");
    const entryCheck = report.execution.find((check) => check.kind === "entry_point");
    expect(entryCheck?.ok).toBe(false);
    expect(entryCheck?.exitCode).toBe(0);
  });

  test("a working deliverable that runs and prints verifies", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "working", scripts: { start: "bun run src/cli.ts" } }),
      "src/cli.ts": `console.log("matched 3 leads");\n`,
    });
    const manifest = manifestOf([await descriptorFor(workspace, "src/cli.ts")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.complete).toBe(true);
    expect(report.failed).toEqual([]);
    const entryCheck = report.execution.find((check) => check.kind === "entry_point");
    expect(entryCheck?.ok).toBe(true);
    expect(entryCheck?.stdoutTail).toContain("matched 3 leads");
  });

  test("a failing declared test suite blocks verification even when the entry point runs", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "flaky", scripts: { start: "bun run src/cli.ts", test: "exit 1" } }),
      "src/cli.ts": `console.log("ran");\n`,
    });
    const manifest = manifestOf([await descriptorFor(workspace, "src/cli.ts")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.complete).toBe(false);
    expect(report.failed).toContain("execution:test");
    const testCheck = report.execution.find((check) => check.kind === "test");
    expect(testCheck?.ok).toBe(false);
    expect(testCheck?.exitCode).toBe(1);
  });

  test("a deliverable with no test files is not blocked by the seeded test script", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "untested", scripts: { start: "bun run src/cli.ts", test: "bun test" } }),
      "src/cli.ts": `console.log("ran");\n`,
    });
    const manifest = manifestOf([await descriptorFor(workspace, "src/cli.ts")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.complete).toBe(true);
    expect(report.failed).not.toContain("execution:test");
    const testCheck = report.execution.find((check) => check.kind === "test");
    expect(testCheck?.ok).toBe(true);
    expect(testCheck?.exitCode).toBe(1);
    expect(testCheck?.detail).toContain("no test files");
  });

  test("test files bun's own glob never collects are a failure, not indistinguishable from no tests", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "misnamed", scripts: { start: "bun run src/cli.ts", test: "bun test" } }),
      "src/cli.ts": `console.log("ran");\n`,
      // Bun's test runner collects `*.test.ts`, not `test_*.ts`: this file
      // is never run, so `bun test` reports "0 test files matching" exactly
      // as it would if no tests existed at all.
      "tests/test_icp.ts": `import { test, expect } from "bun:test";\ntest("stub", () => expect(1).toBe(1));\n`,
    });
    const manifest = manifestOf([await descriptorFor(workspace, "src/cli.ts")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.complete).toBe(false);
    expect(report.failed).toContain("execution:test");
    const testCheck = report.execution.find((check) => check.kind === "test");
    expect(testCheck?.ok).toBe(false);
    expect(testCheck?.detail).toContain("tests/test_icp.ts");
  });

  test("checks that all pass vacuously on an empty workspace do not verify", async () => {
    const workspace = await workspaceWith({
      "package.json": JSON.stringify({ name: "empty", scripts: { test: "bun test", typecheck: "exit 0" } }),
      "README.md": "nothing built yet\n",
    });
    const manifest = manifestOf([await descriptorFor(workspace, "README.md")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.items.every((item) => item.status === "verified")).toBe(true);
    expect(report.execution.every((check) => check.ok)).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.failed).toContain("execution:no_evidence");
  });

  test("no discoverable entry point or declared scripts leaves execution empty, not failing", async () => {
    const workspace = await workspaceWith({
      "dist/chess.app": "not-a-real-binary",
    });
    const manifest = manifestOf([await descriptorFor(workspace, "dist/chess.app")]);

    const report = await verifyManifest("n_manifest", manifest, workspace);

    expect(report.execution).toEqual([]);
    expect(report.complete).toBe(true);
  });
});
