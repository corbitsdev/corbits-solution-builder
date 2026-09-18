import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { listAssets, readAssetJson } from "./assets.js";

/**
 * Fixtures shaped exactly like `formatAssetWithOrigin` / the blob route in
 * `vendor/interchange/packages/hub-api/src/routes/assets.ts`.
 */
function assetRow(id: string, kind: string, tenantId: string) {
  return {
    id,
    tenantId,
    kind,
    name: `${kind}-${id}`,
    displayName: null,
    creatorPrincipalId: "pr_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin: { tenantId, direct: true },
  };
}

function fakeTransport(args: { assets: ReturnType<typeof assetRow>[]; blobsByPath: Record<string, string> }): Transport {
  return {
    async fetch<T>(method: string, path: string): Promise<T> {
      const [pathname, query] = path.split("?");
      const params = new URLSearchParams(query);
      if (method === "GET" && /^\/api\/tenants\/[^/]+\/assets$/.test(pathname ?? "")) {
        const kind = params.get("kind");
        return args.assets.filter((asset) => kind === null || asset.kind === kind) as T;
      }
      const blobMatch = /^\/api\/tenants\/[^/]+\/assets\/([^/]+)\/blob$/.exec(pathname ?? "");
      if (method === "GET" && blobMatch) {
        const key = `${blobMatch[1]}:${params.get("path")}`;
        const text = args.blobsByPath[key];
        if (text === undefined) throw new ApiError(404, "not_found", "not found");
        const bytes = new TextEncoder().encode(text);
        const content = btoa(String.fromCharCode(...bytes));
        return { content } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("listAssets", () => {
  test("filters by kind when given", async () => {
    const transport = fakeTransport({
      assets: [assetRow("a1", "workflow", "tnt_1"), assetRow("a2", "material", "tnt_1")],
      blobsByPath: {},
    });
    const workflows = await listAssets(transport, "tnt_1", { kind: "workflow" });
    expect(workflows.map((row) => row.id)).toEqual(["a1"]);
  });

  test("lists every asset when no kind is given", async () => {
    const transport = fakeTransport({
      assets: [assetRow("a1", "workflow", "tnt_1"), assetRow("a2", "material", "tnt_1")],
      blobsByPath: {},
    });
    const all = await listAssets(transport, "tnt_1");
    expect(all.map((row) => row.id)).toEqual(["a1", "a2"]);
  });
});

describe("readAssetJson", () => {
  test("parses the base64 blob as JSON", async () => {
    const transport = fakeTransport({
      assets: [],
      blobsByPath: { "a1:manifest.json": JSON.stringify({ ok: true }) },
    });
    const parsed = await readAssetJson<{ ok: boolean }>(transport, "tnt_1", "a1", "manifest.json");
    expect(parsed).toEqual({ ok: true });
  });

  test("returns null when the path is absent", async () => {
    const transport = fakeTransport({ assets: [], blobsByPath: {} });
    const parsed = await readAssetJson(transport, "tnt_1", "a1", "missing.json");
    expect(parsed).toBeNull();
  });

  test("returns null when the blob is not valid JSON", async () => {
    const transport = fakeTransport({ assets: [], blobsByPath: { "a1:bad.json": "not json" } });
    const parsed = await readAssetJson(transport, "tnt_1", "a1", "bad.json");
    expect(parsed).toBeNull();
  });
});
