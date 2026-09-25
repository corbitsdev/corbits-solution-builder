import { describe, expect, test } from "bun:test";
import { blocksCollide, defaultProviderId, dropOn, moveBy, moveTo, rankLabel, sameOrder } from "./provider-order.ts";

const ORDER = ["anthropic", "openai", "xai", "ollama"];

describe("provider order moves", () => {
  test("moveTo places an id at an index and clamps to the ends", () => {
    expect(moveTo(ORDER, "xai", 0)).toEqual(["xai", "anthropic", "openai", "ollama"]);
    expect(moveTo(ORDER, "anthropic", 99)).toEqual(["openai", "xai", "ollama", "anthropic"]);
    expect(moveTo(ORDER, "nope", 0)).toEqual(ORDER);
  });
  test("moveBy steps up or down; the head cannot go higher", () => {
    expect(moveBy(ORDER, "xai", -1)).toEqual(["anthropic", "xai", "openai", "ollama"]);
    expect(moveBy(ORDER, "xai", 1)).toEqual(["anthropic", "openai", "ollama", "xai"]);
    expect(moveBy(ORDER, "anthropic", -1)).toEqual(ORDER);
  });
  test("dropOn takes the target's place, shifting the target down; onto itself is no change", () => {
    expect(dropOn(ORDER, "ollama", "openai")).toEqual(["anthropic", "ollama", "openai", "xai"]);
    expect(dropOn(ORDER, "anthropic", "xai")).toEqual(["openai", "anthropic", "xai", "ollama"]);
    expect(dropOn(ORDER, "xai", "xai")).toEqual(ORDER);
  });
  test("sameOrder is positional equality", () => {
    expect(sameOrder(ORDER, [...ORDER])).toBe(true);
    expect(sameOrder(ORDER, moveBy(ORDER, "xai", -1))).toBe(false);
  });
});

describe("where the default comes from", () => {
  const providers = [
    { id: "anthropic", priority: 0, selectedModel: null },
    { id: "openai", priority: 0, selectedModel: "gpt-5.5" },
    { id: "xai", priority: 1, selectedModel: "grok-4" },
  ];
  test("the first provider in order with an enabled model; a fully disabled head is passed over", () => {
    expect(defaultProviderId(["anthropic", "openai", "xai"], providers)).toBe("openai");
    expect(defaultProviderId(["xai", "anthropic", "openai"], providers)).toBe("xai");
    expect(defaultProviderId(["anthropic"], providers)).toBeNull();
  });
  test("two providers in the same block collide; distinct blocks do not", () => {
    expect(blocksCollide(providers)).toBe(true);
    expect(blocksCollide([providers[1]!, providers[2]!])).toBe(false);
  });
});

describe("rankLabel", () => {
  test("the head is the default and tried first; the rest say when they are tried", () => {
    expect(rankLabel(0, true)).toBe("Default · tried first");
    expect(rankLabel(1, true)).toBe("Tried 2nd if the one above fails");
    expect(rankLabel(2, true)).toBe("Tried 3rd if the one above fails");
    expect(rankLabel(3, true)).toBe("Tried 4th if the one above fails");
  });
  test("a row with no model enabled has no place in the order", () => {
    expect(rankLabel(0, false)).toBeNull();
  });
});
