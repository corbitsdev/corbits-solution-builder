/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Transport.fetch<T> is a generic interface method; mock implementations must use `as T` to satisfy the return type contract */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { WORKSPACE_SLUG } from "./hub.js";
import { forgetWorkspace, upgradeWorkspace } from "./install.js";

const SCOPE = "ten_workspace";

type FetchCall = { method: string; path: string };

function page<T>(items: T[]) {
  return { data: items, nextCursor: null };
}

/** A hub whose workspace (if any) has no seeded vendor rows yet, as one installed before the seed existed. */
function hub(options: { signedIn: boolean }) {
  const calls: FetchCall[] = [];
  let nextId = 1;
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path });
      const reply = (() => {
        if (path === "/api/me") return options.signedIn ? { id: "usr_owner" } : null;
        if (path.startsWith("/api/me/principals")) {
          return page([{ principalId: "prn_owner", tenantId: SCOPE, tenantSlug: WORKSPACE_SLUG, kind: "user", status: "active" }]);
        }
        if (method === "GET") return page([]);
        if (method === "POST") return { id: `row_${nextId++}`, ...(body as object) };
        throw new Error(`unexpected call: ${method} ${path}`);
      })();
      return reply as T;
    },
    subscribe(): () => void {
      throw new Error("subscribe is not used by upgradeWorkspace");
    },
  };
  return { transport, calls };
}

describe("upgradeWorkspace", () => {
  beforeEach(() => forgetWorkspace());

  test("does nothing when there is no workspace", async () => {
    const { transport, calls } = hub({ signedIn: false });
    await upgradeWorkspace(transport);
    expect(calls).toEqual([{ method: "GET", path: "/api/me" }]);
  });

  test("backfills the seed and leaves offering order and connected providers alone", async () => {
    const { transport, calls } = hub({ signedIn: true });
    await upgradeWorkspace(transport);
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.some((call) => call.path === `/api/tenants/${SCOPE}/providers`)).toBe(true);
    // The Opus-default migration and the catalog rerank patch offerings; an
    // existing workspace's order is the user's, so neither may run here.
    expect(calls.some((call) => call.path.includes("/catalog/offerings"))).toBe(false);
    expect(writes.some((call) => call.path.includes("/catalog/providers"))).toBe(false);
  });
});
