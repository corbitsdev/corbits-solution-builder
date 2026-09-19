import { afterEach, describe, expect, test } from "bun:test";
import { api, ApiFailure } from "./client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockHub(handlers: Record<string, (init: RequestInit | undefined) => Response>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: href, method, body: init?.body });
    if (href === "/api/me") return json({ id: "user-1" });
    if (href.startsWith("/api/me/principals")) {
      return json({
        data: [{ principalId: "prn_owner", tenantId: "tnt_ws", tenantSlug: "solutions-builder", kind: "user", status: "active" }],
        nextCursor: null,
      });
    }
    const handler = handlers[`${method} ${href}`];
    if (handler) return handler(init);
    return json({ error: { code: "not_found", message: href } }, 404);
  }) as typeof fetch;
  return calls;
}

describe("attachMaterial", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("a text file keeps the plain POST /artifacts path", async () => {
    const calls = mockHub({
      "POST /api/tenants/tnt_ws/artifacts": () => json({ artifact: { id: "art-1" } }, 201),
    });
    const file = new File(["hello world"], "notes.txt", { type: "text/plain" });
    const result = await api.attachMaterial("proj-1", [file]);
    expect(result?.attached).toEqual([{ nodeId: "art-1", name: "notes.txt", mediaType: file.type, sizeBytes: file.size }]);
    expect(calls.some((call) => call.url.includes("/artifacts/upload"))).toBe(false);
    const create = calls.find((call) => call.url === "/api/tenants/tnt_ws/artifacts" && call.method === "POST");
    const body = JSON.parse(String(create?.body));
    expect(body.mode).toBe("text");
    expect(body.metadata.sb.approvedAt).toBeUndefined();
  });

  test("a binary file uploads through the package route, then stamps sb metadata with a metadata-only revise, and writes a companion reading", async () => {
    let revisedBody: unknown;
    let readingBody: unknown;
    const calls = mockHub({
      "POST /api/tenants/tnt_ws/artifacts/upload": () =>
        json({ artifacts: [{ id: "art-2", source: { origin: "imported", upload: { id: "up-1", filename: "report.pdf", mimeType: "application/pdf", size: 4096 } } }] }, 201),
      "POST /api/tenants/tnt_ws/artifacts/art-2/versions": (init) => {
        revisedBody = JSON.parse(String(init?.body));
        return json({ artifactId: "art-2", version: 2, title: "report.pdf", metadata: (revisedBody as { metadata: unknown }).metadata });
      },
      "POST /api/tenants/tnt_ws/artifacts": (init) => {
        readingBody = JSON.parse(String(init?.body));
        return json({ artifact: { id: "art-2-reading" } }, 201);
      },
    });
    const file = new File([new Uint8Array(4096)], "report.pdf", { type: "application/pdf" });
    const result = await api.attachMaterial("proj-1", [file]);
    expect(result?.attached).toEqual([{ nodeId: "art-2", name: "report.pdf", mediaType: "application/pdf", sizeBytes: 4096 }]);
    expect(calls.some((call) => call.url === "/api/tenants/tnt_ws/artifacts/upload" && call.method === "POST")).toBe(true);
    const revise = revisedBody as { content?: unknown; metadata: { sb: Record<string, unknown> } };
    expect(revise.content).toBeUndefined();
    expect(revise.metadata.sb.approvedAt).toBeUndefined();
    expect(revise.metadata.sb.kind).toBe("source_material");
    const reading = readingBody as { metadata: { sb: Record<string, unknown> } };
    expect(reading.metadata.sb.kind).toBe("material_reading");
    expect(reading.metadata.sb.variant).toBe("report.pdf");
    expect(reading.metadata.sb.sourceVersionIds).toEqual(["art-2"]);
    expect(reading.metadata.sb.approvedAt).toBeUndefined();
  });

  test("keeps the attachment when the companion reading write fails", async () => {
    const calls = mockHub({
      "POST /api/tenants/tnt_ws/artifacts/upload": () =>
        json({ artifacts: [{ id: "art-4", source: { origin: "imported", upload: { id: "up-1", filename: "report.pdf", mimeType: "application/pdf", size: 4096 } } }] }, 201),
      "POST /api/tenants/tnt_ws/artifacts/art-4/versions": (init) =>
        json({ artifactId: "art-4", version: 2, title: "report.pdf", metadata: JSON.parse(String(init?.body)).metadata }),
      "POST /api/tenants/tnt_ws/artifacts": () => json({ error: { code: "internal", message: "boom" } }, 500),
    });
    const file = new File([new Uint8Array(4096)], "report.pdf", { type: "application/pdf" });
    const result = await api.attachMaterial("proj-1", [file]);
    expect(result?.attached).toEqual([{ nodeId: "art-4", name: "report.pdf", mediaType: "application/pdf", sizeBytes: 4096, readingFailed: true }]);
    expect(calls.some((call) => call.url === "/api/tenants/tnt_ws/artifacts/art-4/archive")).toBe(false);
  });

  test("archives the uploaded artifact and rethrows when the metadata revise fails", async () => {
    const calls = mockHub({
      "POST /api/tenants/tnt_ws/artifacts/upload": () =>
        json({ artifacts: [{ id: "art-3", source: { origin: "imported", upload: { id: "up-1", filename: "report.pdf", mimeType: "application/pdf", size: 4096 } } }] }, 201),
      "POST /api/tenants/tnt_ws/artifacts/art-3/versions": () => json({ error: { code: "conflict", message: "version conflict" } }, 409),
      "POST /api/tenants/tnt_ws/artifacts/art-3/archive": () => json({ artifact: { id: "art-3", archivedAt: "2026-01-01T00:00:00.000Z" } }),
    });
    const file = new File([new Uint8Array(4096)], "report.pdf", { type: "application/pdf" });
    let caught: unknown;
    try {
      await api.attachMaterial("proj-1", [file]);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ApiFailure);
    expect((caught as ApiFailure).detail.message).toBe("version conflict");
    expect(calls.some((call) => call.url === "/api/tenants/tnt_ws/artifacts/art-3/archive" && call.method === "POST")).toBe(true);
  });

  test("an unsupported type surfaces the package's 415 message verbatim", async () => {
    mockHub({
      "POST /api/tenants/tnt_ws/artifacts/upload": () => json({ error: 'File "virus.exe" has an unsupported type: application/x-msdownload' }, 415),
    });
    const file = new File(["x"], "virus.exe", { type: "application/x-msdownload" });
    let caught: unknown;
    try {
      await api.attachMaterial("proj-1", [file]);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ApiFailure);
    expect((caught as ApiFailure).detail.message).toBe('File "virus.exe" has an unsupported type: application/x-msdownload');
  });
});
