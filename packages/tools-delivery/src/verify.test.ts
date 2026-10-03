import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareArchiveToManifest, extractArchive, hashTree, probeTargets, verifyArchive, type ManifestFileEntry } from "./verify.js";

const entry = (path: string, sha256: string): ManifestFileEntry => ({ path, sha256, sizeBytes: 1 });

describe("compareArchiveToManifest", () => {
  test("a file the archive holds with the manifest's bytes is verified, by the tool", () => {
    const { items, extras } = compareArchiveToManifest([entry("a.ts", "aa")], [entry("a.ts", "aa")]);
    expect(items).toEqual([{ category: "source", path: "a.ts", required: true, status: "verified", checkedBy: "tool" }]);
    expect(extras).toBe(0);
  });

  test("different bytes are a hash mismatch, and an absent file is missing", () => {
    const { items } = compareArchiveToManifest([entry("a.ts", "aa"), entry("b.ts", "bb")], [entry("a.ts", "ab")]);
    expect(items.map((item) => [item.path, item.status])).toEqual([
      ["a.ts", "hash_mismatch"],
      ["b.ts", "missing"],
    ]);
    expect(items.every((item) => item.checkedBy === "tool")).toBe(true);
    expect(items[0]?.detail).toContain("archive holds sha256 ab");
  });

  test("files in the archive the manifest does not list are counted, never claimed", () => {
    const { items, extras } = compareArchiveToManifest([entry("a.ts", "aa")], [entry("a.ts", "aa"), entry("z.ts", "zz")]);
    expect(items).toHaveLength(1);
    expect(extras).toBe(1);
  });
});

async function fixtureTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sb-verify-fixture-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "README.md"), "# hi\n");
  await writeFile(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  return dir;
}

function tarOf(dir: string, exclude: readonly string[]): Uint8Array {
  const result = Bun.spawnSync(["tar", "-czf", "-", ...exclude.map((name) => `--exclude=${name}`), "."], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return new Uint8Array(result.stdout);
}

describe("hashTree and extractArchive", () => {
  test("the archive's extracted contents hash the same as the tree it was made from", async () => {
    const dir = await fixtureTree();
    try {
      const exclude = new Set(["node_modules"]);
      const manifest = await hashTree(dir, exclude);
      expect(manifest.map((file) => file.path)).toEqual(["README.md", "src/index.ts"]);
      const extracted = await extractArchive(tarOf(dir, ["node_modules"]));
      try {
        const archive = await hashTree(extracted, exclude);
        expect(compareArchiveToManifest(manifest, archive).items.every((item) => item.status === "verified")).toBe(true);
      } finally {
        await rm(extracted, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file changed after the archive was made is a hash mismatch against it", async () => {
    const dir = await fixtureTree();
    try {
      const bytes = tarOf(dir, ["node_modules"]);
      await writeFile(join(dir, "src", "index.ts"), "export const x = 2;\n");
      await writeFile(join(dir, "src", "new.ts"), "export const y = 2;\n");
      const verification = await verifyArchive({
        archiveBytes: bytes,
        manifest: await hashTree(dir, new Set(["node_modules"])),
        manifestNodeId: "sha256:test",
        probes: [],
        cwd: dir,
        exclude: new Set(["node_modules"]),
        ranOn: "sidecar",
      });
      expect(verification.checkedBy).toBe("tool");
      expect(verification.items.map((item) => [item.path, item.status])).toEqual([
        ["README.md", "verified"],
        ["src/index.ts", "hash_mismatch"],
        ["src/new.ts", "missing"],
        ["tests", "failed"],
      ]);
      expect(verification.report.complete).toBe(false);
      expect(verification.report.failed).toEqual(["src/index.ts", "src/new.ts", "tests"]);
      expect(verification.targets).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeFixtureServer(dir: string): Promise<string> {
  const file = join(dir, "server.ts");
  await writeFile(
    file,
    `
const port = Number(process.env.FIXTURE_PORT);
Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("<html><body>hi</body></html>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  },
});
`,
  );
  return file;
}

const freePort = () => 20_000 + Math.floor(Math.random() * 20_000);

describe("probeTargets", () => {
  test("an api target that opens its port and answers its routes is verified; one that never opens is failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sb-probe-"));
    try {
      const server = await writeFixtureServer(dir);
      const port = freePort();
      const { items, targets } = await probeTargets(
        [
          { target: "api", command: ["sh", "-c", `FIXTURE_PORT=${String(port)} exec bun ${server}`], port, routes: ["/health"] },
          { target: "web", command: ["sh", "-c", "exit 0"], port: freePort(), routes: [], startTimeoutMs: 300 },
        ],
        dir,
      );
      expect(items.map((item) => [item.path, item.status, item.checkedBy])).toEqual([
        ["target:api", "verified", "tool"],
        ["target:web", "failed", "tool"],
      ]);
      expect(targets[0]?.transcript).toContain("GET /health -> 200");
      expect(targets[1]?.transcript).toContain("never accepted a connection");
      expect(items[1]?.detail).toContain("never accepted a connection");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a target with no verifier is inaccessible, never assumed", async () => {
    const { items, targets } = await probeTargets([{ target: "cli", command: ["true"], port: 1, routes: [] }], tmpdir());
    expect(items).toEqual([
      { category: "receipts", path: "target:cli", required: true, status: "inaccessible", checkedBy: "tool", detail: expect.stringContaining("no cli verifier") },
    ]);
    expect(targets[0]?.exercised).toBe(false);
  });
});
