import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockHub(handlers: Record<string, (init: RequestInit | undefined) => Response>) {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: href, method });
    const handler = handlers[`${method} ${href}`];
    if (handler) return handler(init);
    return json({ error: { code: "not_found", message: href } }, 404);
  }) as typeof fetch;
  return calls;
}

describe("artifactContent download-path selection", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("an upload-backed artifact (kind file, blob id present) reads bytes through the package's download route", async () => {
    const calls = mockHub({
      "GET /api/tenants/tnt/artifacts/art-1": () =>
        json({
          artifact: {
            id: "art-1",
            kind: "file",
            title: "report.pdf",
            content: "",
            source: { origin: "imported", upload: { id: "up-1", filename: "report.pdf", mimeType: "application/pdf", size: 3 } },
          },
        }),
      "GET /api/tenants/tnt/artifacts/art-1/download": () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    const result = await api.artifactContent("tnt", "art-1");
    expect(calls).toContainEqual({ url: "/api/tenants/tnt/artifacts/art-1/download", method: "GET" });
    expect(result.content.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  test("a legacy data-URL/text artifact reads content straight off the artifact, no download route hit", async () => {
    const calls = mockHub({
      "GET /api/tenants/tnt/artifacts/art-2": () =>
        json({
          artifact: {
            id: "art-2",
            kind: "document",
            title: "notes.txt",
            content: "hello world",
            source: { origin: "manual" },
          },
        }),
    });
    const result = await api.artifactContent("tnt", "art-2");
    expect(result.content).toBe("hello world");
    expect(calls.some((call) => call.url.endsWith("/download"))).toBe(false);
  });
});
