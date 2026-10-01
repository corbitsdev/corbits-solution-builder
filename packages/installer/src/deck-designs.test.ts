import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { DECK_DESIGNS_CONFIG_KEY } from "@solutions-builder/app/deck-designs";
import { readDeckDesigns, saveDeckDesignPreference } from "./deck-designs.js";

type Row = { id: string; name: string; config?: Record<string, unknown>; createdAt: string };

function fakeTenant(config?: Record<string, unknown>): { row: Row; transport: Transport; requests: string[] } {
  const row: Row = { id: "tnt_ws", name: "Workspace", createdAt: "2026-01-01T00:00:00.000Z", ...(config ? { config } : {}) };
  const requests: string[] = [];
  const transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      requests.push(`${method} ${path}`);
      if (method === "GET" && path === "/api/tenants/tnt_ws") return row as T;
      if (method === "PATCH" && path === "/api/tenants/tnt_ws") {
        const patch = body as { config?: Record<string, unknown> };
        if (patch.config !== undefined) row.config = patch.config;
        return row as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
  return { row, transport, requests };
}

describe("deck design preferences on the tenant config", () => {
  test("nothing saved reads as an empty map", async () => {
    const { transport, requests } = fakeTenant();
    expect(await readDeckDesigns(transport, "tnt_ws")).toEqual({});
    expect(requests).toEqual(["GET /api/tenants/tnt_ws"]);
  });

  test("a save is one GET and one PATCH, and later saves keep earlier keys and the rest of the bag", async () => {
    const { row, transport, requests } = fakeTenant({ solutionsBuilder: { revision: 1 } });
    await saveDeckDesignPreference(transport, "tnt_ws", "deck.cfo.theme", "slate");
    expect(requests).toEqual(["GET /api/tenants/tnt_ws", "PATCH /api/tenants/tnt_ws"]);
    const next = await saveDeckDesignPreference(transport, "tnt_ws", "deck.cfo.notes", false);
    expect(next).toEqual({ "deck.cfo.theme": "slate", "deck.cfo.notes": false });
    expect(row.config).toEqual({ solutionsBuilder: { revision: 1 }, [DECK_DESIGNS_CONFIG_KEY]: next });
    expect(await readDeckDesigns(transport, "tnt_ws")).toEqual(next);
  });
});
