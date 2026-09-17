import { describe, expect, test } from "bun:test";
import {
  closureFiles,
  deckAppMemberFiles,
  toolsDeckMemberFiles,
  toolsDeliveryMemberFiles,
  treeDigest,
  workspaceCatalog,
} from "./workflow-closure.js";

describe("workflow-closure embed", () => {
  test("the install() closure path does not import node:fs", async () => {
    const source = await Bun.file(new URL("./workflow-closure.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from ["']node:fs["']/);
    expect(source).not.toMatch(/from ["']node:fs\/promises["']/);
    expect(source).toContain("workflow-closure-embed");
  });

  test("closureFiles ships vendored workflow members from the embed", () => {
    const files = closureFiles("workflow");
    expect(files["packages/intx-workflow/package.json"]).toContain('"name": "@intx/workflow"');
    expect(Object.keys(files).some((path) => path.startsWith("packages/intx-workflow/dist/"))).toBe(true);
    expect(treeDigest(files).length).toBe(64);
  });

  test("deck and tools members match the live source files", async () => {
    const deck = await Bun.file(new URL("../../solutions-builder/src/deck.ts", import.meta.url)).text();
    const delivery = await Bun.file(new URL("../../solutions-builder/src/delivery.ts", import.meta.url)).text();
    const members = deckAppMemberFiles();
    expect(members["packages/solutions-builder-app/src/deck.ts"]).toBe(deck);
    expect(members["packages/solutions-builder-app/src/delivery.ts"]).toBe(delivery);
    expect(Object.keys(toolsDeckMemberFiles()).some((path) => path.endsWith("src/sidecar-bundle.ts"))).toBe(true);
    expect(Object.keys(toolsDeliveryMemberFiles()).some((path) => path.endsWith("src/sidecar-bundle.ts"))).toBe(true);
    expect(Object.keys(workspaceCatalog()).length).toBeGreaterThan(0);
  });
});
