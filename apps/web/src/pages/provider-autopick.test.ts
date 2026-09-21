import { describe, expect, test } from "bun:test";
import { needsModelChoice } from "./onboarding.jsx";
import { autoPickModel } from "./providers.jsx";

describe("autoPickModel", () => {
  test("pins the first served model when nothing is chosen", () => {
    expect(autoPickModel({ selectedModel: null, models: ["model-a", "model-b"] })).toBe("model-a");
  });

  test("leaves an explicit choice alone", () => {
    expect(autoPickModel({ selectedModel: "model-b", models: ["model-a", "model-b"] })).toBeNull();
  });

  test("pins nothing when no models are served", () => {
    expect(autoPickModel({ selectedModel: null, models: [] })).toBeNull();
  });
});

describe("needsModelChoice", () => {
  test("an auto-picked provider never triggers the model step", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: "model-a", models: ["model-a", "model-b"] })).toBe(false);
  });

  test("a ready provider with an unmade multi-model choice still does", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: null, models: ["model-a", "model-b"] })).toBe(true);
  });

  test("a single-model provider does not", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: null, models: ["model-a"] })).toBe(false);
  });

  test("a provider that is not ready does not", () => {
    expect(needsModelChoice({ status: "error", selectedModel: null, models: ["model-a", "model-b"] })).toBe(false);
  });
});
