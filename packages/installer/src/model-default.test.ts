import { describe, expect, test } from "bun:test";
import {
  computeMakeDefaultPatches,
  MakeDefaultError,
  type DefaultableOffering,
} from "./model-default.js";

const SONNET = "model_sonnet";
const OPUS = "model_opus";
const HAIKU = "model_haiku";

function offering(id: string, modelId: string, priority: number, disabled = false): DefaultableOffering {
  return { id, modelId, priority, disabled };
}

describe("computeMakeDefaultPatches", () => {
  test("already-default target yields the empty set", () => {
    const resolved = [offering("off_sonnet", SONNET, 0), offering("off_opus", OPUS, 5)];
    expect(computeMakeDefaultPatches(resolved, SONNET)).toEqual([]);
  });

  test("promotes the target and demotes the current default, nothing else", () => {
    const resolved = [
      offering("off_sonnet", SONNET, 0),
      offering("off_opus", OPUS, 5),
      offering("off_haiku", HAIKU, 10),
    ];
    const patches = computeMakeDefaultPatches(resolved, OPUS);
    expect(patches).toEqual([
      { id: "off_opus", priority: 0 },
      { id: "off_sonnet", priority: 5 },
    ]);
    // Minimal: exactly the swap, and payloads carry priority only — the
    // apply step can never touch a disabled flag through these.
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      expect(Object.keys(patch).sort()).toEqual(["id", "priority"]);
    }
  });

  test("refuses a restricted (disabled) target with a typed error", () => {
    const resolved = [offering("off_sonnet", SONNET, 0), offering("off_opus", OPUS, 5, true)];
    try {
      computeMakeDefaultPatches(resolved, OPUS);
      throw new Error("expected computeMakeDefaultPatches to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MakeDefaultError);
      expect((cause as MakeDefaultError).code).toBe("restricted");
    }
  });

  test("refuses an unknown target with a typed error", () => {
    const resolved = [offering("off_sonnet", SONNET, 0)];
    try {
      computeMakeDefaultPatches(resolved, "model_missing");
      throw new Error("expected computeMakeDefaultPatches to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MakeDefaultError);
      expect((cause as MakeDefaultError).code).toBe("unknown-target");
    }
  });

  test("skips disabled offerings when finding the current default", () => {
    const resolved = [
      offering("off_sonnet", SONNET, 0, true),
      offering("off_haiku", HAIKU, 3),
      offering("off_opus", OPUS, 5),
    ];
    // Haiku leads the enabled order, so opus swaps with haiku — the
    // restricted sonnet row is never a patch target.
    expect(computeMakeDefaultPatches(resolved, OPUS)).toEqual([
      { id: "off_opus", priority: 3 },
      { id: "off_haiku", priority: 5 },
    ]);
  });

  test("does not mutate the input array", () => {
    const resolved = [offering("off_opus", OPUS, 5), offering("off_sonnet", SONNET, 0)];
    const snapshot = resolved.map((o) => ({ ...o }));
    computeMakeDefaultPatches(resolved, OPUS);
    expect(resolved).toEqual(snapshot);
  });
});
