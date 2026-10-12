import { describe, expect, test } from "bun:test";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";
import type { StackRecord } from "@solutions-builder/app/stack";
import { buildPromptMaterial } from "./build.tsx";

const CHOICE = { reason: "because", cites: ["FR-1"] };
const STACK: StackRecord = {
  mode: "inference",
  runtime: { ...CHOICE, choice: "Capacitor iOS shell" },
  ui: null,
  storage: null,
  auth: null,
  packaging: { ...CHOICE, choice: "Xcode-built iOS app installed from your Mac", kind: "compiled-binary" },
  packages: [],
  deferred: [],
};
const FREEZE: Freeze = { target: "desktop", frozen: [], stack: STACK, decisionId: "dec-1" };

// #882: the packet said "Target: desktop." for a phone app, from the
// stored id alone; the worker read it against the plan and stopped.
describe("buildPromptMaterial", () => {
  test("names the target in the person's words, with the frozen choices in the stack block", async () => {
    const material = await buildPromptMaterial("tnt", [], FREEZE, async () => "", async () => "English");
    expect(material.target).toBe("an app you install");
    expect(material.stackBlock).toContain("- Ships as: Xcode-built iOS app installed from your Mac");
  });

  test("without a freeze there is no target and no stack block", async () => {
    const material = await buildPromptMaterial("tnt", [], null, async () => "", async () => "English");
    expect(material.target).toBe("");
    expect(material.stackBlock).toBe("");
  });
});
