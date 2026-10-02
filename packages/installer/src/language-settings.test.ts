import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { DEFAULT_LANGUAGE_SETTINGS, LANGUAGE_SETTINGS_CONFIG_KEY } from "@solutions-builder/app/language-settings";
import { readLanguageSettings, saveLanguageSettings } from "./language-settings.js";

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

describe("language settings on the tenant config", () => {
  test("nothing saved reads as American English both ways", async () => {
    const { transport } = fakeTenant();
    expect(await readLanguageSettings(transport, "tnt_ws")).toEqual(DEFAULT_LANGUAGE_SETTINGS);
  });

  test("a save keeps the tenant's other config and refuses an unsupported output", async () => {
    const { row, transport, requests } = fakeTenant({ "sb.other": 1 });
    expect(await saveLanguageSettings(transport, "tnt_ws", { output: "en-GB" })).toEqual({ input: "en-US", output: "en-GB" });
    expect(row.config).toEqual({ "sb.other": 1, [LANGUAGE_SETTINGS_CONFIG_KEY]: { input: "en-US", output: "en-GB" } });
    expect(requests).toEqual(["GET /api/tenants/tnt_ws", "PATCH /api/tenants/tnt_ws"]);
    await expect(saveLanguageSettings(transport, "tnt_ws", { output: "de" })).rejects.toThrow(/German is not supported/);
  });
});
