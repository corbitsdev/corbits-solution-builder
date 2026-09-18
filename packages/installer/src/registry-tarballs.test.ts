import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import {
  ensureRegistryTarballs,
  REGISTRY_ASSET_NAME,
  type ClosureManifest,
  type RegistryTarballUploader,
} from "./registry-tarballs.js";

const SCOPE = "tnt_ws";
const ASSET_ID = "ast_registry";

/**
 * A fake `Transport` serving the two JSON routes `ensureRegistryTarballs`
 * reads: the asset list/create routes and the tarball listing route.
 * Follows `project-tenant.test.ts`'s pattern.
 */
function fakeTransport(state: {
  assets: { id: string; tenantId: string; kind: string; name: string }[];
  tarballs: string[];
}): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const pathname = path.split("?")[0] ?? path;
      if (method === "GET" && pathname === `/api/tenants/${SCOPE}/assets`) {
        return state.assets.filter((a) => a.tenantId === SCOPE) as T;
      }
      if (method === "POST" && pathname === `/api/tenants/${SCOPE}/assets`) {
        const input = body as { kind: string; name: string; displayName?: string };
        const created = { id: ASSET_ID, tenantId: SCOPE, kind: input.kind, name: input.name };
        state.assets.push(created);
        return created as T;
      }
      if (method === "GET" && pathname === `/api/tenants/${SCOPE}/assets/${ASSET_ID}/tarballs`) {
        return state.tarballs.map((filename) => ({ filename, size: 1, integrity: "sha512-x" })) as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

function manifest(entries: { name: string; version: string; filename: string; sha256: string }[]): ClosureManifest {
  return { digest: "d", packages: entries, catalog: {} };
}

describe("ensureRegistryTarballs", () => {
  test("creates the registry asset when the tenant has none yet", async () => {
    const transport = fakeTransport({ assets: [], tarballs: [] });
    const uploaded: string[] = [];
    const uploader: RegistryTarballUploader = {
      async putTarball(assetId, filename) {
        expect(assetId).toBe(ASSET_ID);
        uploaded.push(filename);
      },
    };
    const result = await ensureRegistryTarballs(
      transport,
      SCOPE,
      uploader,
      manifest([{ name: "a", version: "1.0.0", filename: "a-1.0.0.tgz", sha256: "s1" }]),
      async () => new Uint8Array([1, 2, 3]),
    );
    expect(result.assetId).toBe(ASSET_ID);
    expect(uploaded).toEqual(["a-1.0.0.tgz"]);
  });

  test("reuses an existing registry asset by name rather than creating a second one", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, tenantId: SCOPE, kind: "package-registry", name: REGISTRY_ASSET_NAME }],
      tarballs: [],
    });
    const uploader: RegistryTarballUploader = { async putTarball() {} };
    const result = await ensureRegistryTarballs(
      transport,
      SCOPE,
      uploader,
      manifest([]),
      async () => new Uint8Array(),
    );
    expect(result.assetId).toBe(ASSET_ID);
  });

  test("skips tarballs already present on the asset, by filename, without fetching or uploading them", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, tenantId: SCOPE, kind: "package-registry", name: REGISTRY_ASSET_NAME }],
      tarballs: ["a-1.0.0.tgz"],
    });
    let fetches = 0;
    const uploaded: string[] = [];
    const uploader: RegistryTarballUploader = {
      async putTarball(_assetId, filename) {
        uploaded.push(filename);
      },
    };
    const result = await ensureRegistryTarballs(
      transport,
      SCOPE,
      uploader,
      manifest([
        { name: "a", version: "1.0.0", filename: "a-1.0.0.tgz", sha256: "s1" },
        { name: "b", version: "2.0.0", filename: "b-2.0.0.tgz", sha256: "s2" },
      ]),
      async (filename) => {
        fetches += 1;
        return new TextEncoder().encode(filename);
      },
    );
    expect(result.skipped).toEqual(["a-1.0.0.tgz"]);
    expect(result.uploaded).toEqual(["b-2.0.0.tgz"]);
    expect(uploaded).toEqual(["b-2.0.0.tgz"]);
    expect(fetches).toBe(1);
  });

  test("re-running against a fully-present asset uploads nothing", async () => {
    const transport = fakeTransport({
      assets: [{ id: ASSET_ID, tenantId: SCOPE, kind: "package-registry", name: REGISTRY_ASSET_NAME }],
      tarballs: ["a-1.0.0.tgz"],
    });
    let putCalls = 0;
    const uploader: RegistryTarballUploader = {
      async putTarball() {
        putCalls += 1;
      },
    };
    const result = await ensureRegistryTarballs(
      transport,
      SCOPE,
      uploader,
      manifest([{ name: "a", version: "1.0.0", filename: "a-1.0.0.tgz", sha256: "s1" }]),
      async () => {
        throw new Error("must not fetch bytes for an already-present tarball");
      },
    );
    expect(putCalls).toBe(0);
    expect(result.uploaded).toEqual([]);
    expect(result.skipped).toEqual(["a-1.0.0.tgz"]);
  });
});
