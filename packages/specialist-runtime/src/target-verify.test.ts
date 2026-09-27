import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyApiTarget, verifyWebTarget } from "./target-verify.js";

/** A real Bun HTTP server, written to disk and started as a real subprocess
 *  — the fixture exercises the same "start a command, hit a port" path a
 *  real deliverable would, not a mock. */
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
    if (url.pathname === "/") {
      return new Response("<html><head><link rel=\\"stylesheet\\" href=\\"/style.css\\"></head><body>hi</body></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/style.css") return new Response("body{}", { headers: { "content-type": "text/css" } });
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  },
});
`,
  );
  return file;
}

function freePort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

describe("verifyApiTarget", () => {
  test("starts the process, waits for the port, and hits declared routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "target-verify-api-"));
    try {
      const server = await writeFixtureServer(dir);
      const port = freePort();
      const result = await verifyApiTarget("api", {
        command: ["bun", "run", server],
        cwd: dir,
        port,
        env: { FIXTURE_PORT: String(port) },
        routes: ["/", "/health"],
      });
      expect(result.exercised).toBe(true);
      expect(result.ranSuccessfully).toBe(true);
      expect(result.producedOutput).toBe(true);
      expect(result.transcript).toContain("GET / -> 200");
      expect(result.transcript).toContain("GET /health -> 200");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("reports an unreachable route rather than hiding it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "target-verify-api-"));
    try {
      const server = await writeFixtureServer(dir);
      const port = freePort();
      const result = await verifyApiTarget("api", {
        command: ["bun", "run", server],
        cwd: dir,
        port,
        env: { FIXTURE_PORT: String(port) },
        routes: ["/missing"],
      });
      expect(result.exercised).toBe(true);
      expect(result.transcript).toContain("GET /missing -> 404");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a port that never opens is reported as not run successfully, not faked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "target-verify-api-"));
    try {
      const port = freePort();
      const result = await verifyApiTarget("api", {
        command: ["sleep", "5"],
        cwd: dir,
        port,
        routes: ["/"],
        startTimeoutMs: 500,
      });
      expect(result.exercised).toBe(true);
      expect(result.ranSuccessfully).toBe(false);
      expect(result.producedOutput).toBe(false);
      expect(result.transcript).toContain("never accepted a connection");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("verifyWebTarget", () => {
  test("loads the page and one referenced asset over HTTP, and says this is not a browser check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "target-verify-web-"));
    try {
      const server = await writeFixtureServer(dir);
      const port = freePort();
      const result = await verifyWebTarget("web", {
        command: ["bun", "run", server],
        cwd: dir,
        port,
        env: { FIXTURE_PORT: String(port) },
      });
      expect(result.exercised).toBe(true);
      expect(result.ranSuccessfully).toBe(true);
      expect(result.producedOutput).toBe(true);
      expect(result.transcript).toContain("GET http://127.0.0.1");
      expect(result.transcript).toContain("style.css -> 200");
      expect(result.transcript).toContain("not a browser");
      expect(result.transcript).toContain("no playwright, no puppeteer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a port that never opens is reported honestly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "target-verify-web-"));
    try {
      const port = freePort();
      const result = await verifyWebTarget("web", {
        command: ["sleep", "5"],
        cwd: dir,
        port,
        startTimeoutMs: 500,
      });
      expect(result.exercised).toBe(true);
      expect(result.ranSuccessfully).toBe(false);
      expect(result.transcript).toContain("never accepted a connection");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
