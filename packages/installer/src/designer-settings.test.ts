import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { DEFAULT_DESIGNER_SETTINGS, DESIGNER_SETTINGS_CONFIG_KEY } from "@solutions-builder/app/designer-settings";
import { readDesignerSettings, saveDesignerSettings } from "./designer-settings.js";

type Row = { id: string; name: string; config?: Record<string, unknown>; createdAt: string };

// #358: the hub's asset route accepts only its own kinds, so settings live in
// the tenant's config. The fake answers the two stock tenant routes and
// refuses everything else, so a save that reached for an asset would fail.
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

describe("designer settings on the tenant config", () => {
  test("a tenant with nothing saved reads as the defaults", async () => {
    const { transport, requests } = fakeTenant();
    expect(await readDesignerSettings(transport, "tnt_ws")).toEqual(DEFAULT_DESIGNER_SETTINGS);
    expect(requests).toEqual(["GET /api/tenants/tnt_ws"]);
  });

  test("a save is one GET and one PATCH on the tenant, nothing else", async () => {
    const { row, transport, requests } = fakeTenant();
    const saved = await saveDesignerSettings(transport, "tnt_ws", { surface: "dark" });
    expect(saved).toEqual({ ...DEFAULT_DESIGNER_SETTINGS, surface: "dark" });
    expect(requests).toEqual(["GET /api/tenants/tnt_ws", "PATCH /api/tenants/tnt_ws"]);
    expect(row.config?.[DESIGNER_SETTINGS_CONFIG_KEY]).toEqual(saved);
  });

  test("a save merges into the config bag and keeps what else is there", async () => {
    const { row, transport } = fakeTenant({ solutionsBuilder: { policy: "p", revision: 3 } });
    await saveDesignerSettings(transport, "tnt_ws", { surface: "dark" });
    await saveDesignerSettings(transport, "tnt_ws", { language: "warm, editorial" });
    expect(row.config).toEqual({
      solutionsBuilder: { policy: "p", revision: 3 },
      [DESIGNER_SETTINGS_CONFIG_KEY]: { ...DEFAULT_DESIGNER_SETTINGS, surface: "dark", language: "warm, editorial" },
    });
    expect(await readDesignerSettings(transport, "tnt_ws")).toEqual({
      ...DEFAULT_DESIGNER_SETTINGS,
      surface: "dark",
      language: "warm, editorial",
    });
  });

  test("a value the type rejects is refused and nothing is written", async () => {
    const { row, transport, requests } = fakeTenant();
    await expect(saveDesignerSettings(transport, "tnt_ws", { maxTokens: 1 })).rejects.toThrow("Designer settings");
    expect(requests).toEqual(["GET /api/tenants/tnt_ws"]);
    expect(row.config).toBeUndefined();
  });

  test("an unreadable saved value reads as the defaults rather than failing", async () => {
    const { transport } = fakeTenant({ [DESIGNER_SETTINGS_CONFIG_KEY]: "not an object" });
    expect(await readDesignerSettings(transport, "tnt_ws")).toEqual(DEFAULT_DESIGNER_SETTINGS);
  });
});
