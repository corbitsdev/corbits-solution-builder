import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { interfacePackSteps } from "./interface-build.js";

describe("interface pack steps", () => {
  test("are the bun run steps ui:build names before vite", () => {
    expect(interfacePackSteps("bun run assets:pack-closure && bun run assets:pack-project-workflow && vite build -c x")).toEqual([
      "assets:pack-closure",
      "assets:pack-project-workflow",
    ]);
  });

  test("a build that is only vite has none", () => {
    expect(interfacePackSteps("vite build -c apps/web/vite.config.ts")).toEqual([]);
  });

  test("steps after vite are not packing steps", () => {
    expect(interfacePackSteps("bun run a && vite build && bun run b")).toEqual(["a"]);
  });

  test("the repository's own ui:build packs the closure and the project workflow", async () => {
    const { scripts } = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { scripts: Record<string, string> };
    expect(interfacePackSteps(scripts["ui:build"]!)).toEqual(["assets:pack-closure", "assets:pack-project-workflow"]);
  });
});
