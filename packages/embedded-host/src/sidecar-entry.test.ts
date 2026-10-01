import { describe, expect, test } from "bun:test";
import { sidecarEntry } from "./sidecar-entry.ts";

describe("sidecarEntry", () => {
  test("prefers the bundle and says nothing", () => {
    const said: string[] = [];
    const entry = sidecarEntry("/v/apps/sidecar", (line) => said.push(line), (path) => path.endsWith("dist/index.js"));
    expect(entry).toBe("/v/apps/sidecar/dist/index.js");
    expect(said).toEqual([]);
  });

  test("falls back to the source entry and names the missing bundle", () => {
    const said: string[] = [];
    const entry = sidecarEntry("/v/apps/sidecar", (line) => said.push(line), () => false);
    expect(entry).toBe("/v/apps/sidecar/src/index.ts");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("/v/apps/sidecar/dist/index.js");
    expect(said[0]).toContain("vendor:build");
  });
});
