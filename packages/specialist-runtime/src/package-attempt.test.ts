import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRoot, ensureExecutableScripts, packageAttempt, tarDirectory } from "./package-attempt.js";
import { chmod, stat } from "node:fs/promises";

async function fixtureTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sb-pack-fixture-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "README.md"), "# hi\n");
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "USER-MANUAL.md"), "# Using it\n");
  await writeFile(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  return dir;
}

function entriesOf(bytes: Uint8Array): string[] {
  const result = Bun.spawnSync(["tar", "-tzf", "-"], { stdin: bytes });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\n").filter((line) => line.length > 0).sort();
}

// #699: the archive unpacks into one folder.
describe("archiveRoot", () => {
  test("is the file name's stem, made safe, and never empty", () => {
    expect(archiveRoot("build.tar.gz")).toBe("build");
    expect(archiveRoot("agentic-agency-attempt-1.tar.gz")).toBe("agentic-agency-attempt-1");
    expect(archiveRoot("x.tgz")).toBe("x");
    expect(archiveRoot("../evil/name.tar.gz")).toBe("-evil-name");
    expect(archiveRoot(".tar.gz")).toBe("build");
  });
});

describe("tarDirectory", () => {
  test("packs every listed file under the root folder, as regular files", async () => {
    const dir = await fixtureTree();
    try {
      const bytes = await tarDirectory(dir, ["README.md", "src/index.ts"], "my-build");
      expect(entriesOf(bytes)).toEqual(["my-build/README.md", "my-build/src/index.ts"]);
      const flat = await tarDirectory(dir, ["README.md", "src/index.ts"]);
      expect(entriesOf(flat)).toEqual(["README.md", "src/index.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("packageAttempt", () => {
  test("names the folder on the manifest, keeps manifest paths relative to the build, and the archive verifies complete", async () => {
    const dir = await fixtureTree();
    try {
      const packaged = await packageAttempt({ dir, attempt: "attempt-1", fileName: "agentic-agency-attempt-1.tar.gz", root: "agentic-agency-attempt-1", ranOn: "host" });
      expect(packaged.fileName).toBe("agentic-agency-attempt-1.tar.gz");
      expect(packaged.manifest.archive.root).toBe("agentic-agency-attempt-1");
      expect(packaged.manifest.files.map((file) => file.path)).toEqual(["README.md", "docs/USER-MANUAL.md", "src/index.ts"]);
      expect(packaged.verification.complete).toBe(true);
      expect(packaged.manifest.verification?.archiveExtras).toBe(0);
      const bytes = Buffer.from(packaged.dataUri.slice(packaged.dataUri.indexOf(",") + 1), "base64");
      expect(entriesOf(bytes)).toEqual(["agentic-agency-attempt-1/README.md", "agentic-agency-attempt-1/docs/USER-MANUAL.md", "agentic-agency-attempt-1/src/index.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults the folder to the file name's stem", async () => {
    const dir = await fixtureTree();
    try {
      const packaged = await packageAttempt({ dir, attempt: "attempt-1" });
      expect(packaged.fileName).toBe("build.tar.gz");
      expect(packaged.manifest.archive.root).toBe("build");
      expect(packaged.verification.complete).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// #733: a build without its two documents is recorded as incomplete.
describe("the documents every build ships", () => {
  test("a missing user manual is a missing docs item, and the verification is incomplete", async () => {
    const dir = await fixtureTree();
    try {
      await rm(join(dir, "docs"), { recursive: true, force: true });
      const packaged = await packageAttempt({ dir, attempt: "attempt-1" });
      expect(packaged.verification.complete).toBe(false);
      expect(packaged.verification.failed).toContain("docs/USER-MANUAL.md");
      const item = packaged.manifest.verification?.items.find((entry) => entry.path === "docs/USER-MANUAL.md");
      expect(item).toMatchObject({ category: "docs", required: true, status: "missing", checkedBy: "tool" });
      expect(packaged.manifest.verification?.items.find((entry) => entry.path === "README.md" && entry.category === "docs")).toMatchObject({ status: "verified", checkedBy: "tool" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// #744: a shebang script ships executable, whatever the worker left.
describe("ensureExecutableScripts", () => {
  test("sets the bit on shebang files that lack it, leaves other files and already-executable scripts alone, and the archive carries it", async () => {
    const dir = await fixtureTree();
    try {
      await mkdir(join(dir, "scripts"), { recursive: true });
      await writeFile(join(dir, "scripts", "dev-db.sh"), "#!/bin/sh\necho db\n", { mode: 0o644 });
      await writeFile(join(dir, "scripts", "already.sh"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(dir, "scripts", "notes.txt"), "#not a shebang\n", { mode: 0o644 });
      const fixed = await ensureExecutableScripts(dir, ["README.md", "scripts/dev-db.sh", "scripts/already.sh", "scripts/notes.txt"]);
      expect(fixed).toEqual(["scripts/dev-db.sh"]);
      expect((await stat(join(dir, "scripts", "dev-db.sh"))).mode & 0o111).toBe(0o111);
      expect((await stat(join(dir, "scripts", "notes.txt"))).mode & 0o111).toBe(0);
      expect((await stat(join(dir, "README.md"))).mode & 0o111).toBe(0);
      // Packaging does the same and says so on the manifest; the tar entry is executable.
      await chmod(join(dir, "scripts", "dev-db.sh"), 0o644);
      const packaged = await packageAttempt({ dir, attempt: "attempt-1" });
      expect(packaged.manifest.scriptsMadeExecutable).toEqual(["scripts/dev-db.sh"]);
      const bytes = Buffer.from(packaged.dataUri.slice(packaged.dataUri.indexOf(",") + 1), "base64");
      const listing = Bun.spawnSync(["tar", "-tvzf", "-"], { stdin: new Uint8Array(bytes) }).stdout.toString();
      const line = listing.split("\n").find((entry) => entry.endsWith("build/scripts/dev-db.sh")) ?? "";
      expect(line.startsWith("-rwx")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
