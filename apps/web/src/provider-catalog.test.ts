import { describe, expect, test } from "bun:test";
import {
  droppedSelection,
  isSealedCredentialFailure,
  ProviderRejectedError,
  requireDiscoveredModels,
} from "./provider-catalog.ts";

describe("droppedSelection", () => {
  test("keeps a selection the fresh discovery still serves", () => {
    expect(droppedSelection("gpt-5.5", ["gpt-5.5", "gpt-5.5-mini"])).toBeNull();
  });

  test("drops a selection the fresh discovery no longer serves", () => {
    expect(droppedSelection("gpt-4", ["gpt-5.5", "gpt-5.5-mini"])).toBe("gpt-4");
  });

  test("leaves no selection alone", () => {
    expect(droppedSelection(null, ["gpt-5.5"])).toBeNull();
  });
});

describe("isSealedCredentialFailure", () => {
  test("recognizes a 401", () => {
    expect(isSealedCredentialFailure(new ProviderRejectedError(401, "nope"))).toBe(true);
  });

  test("recognizes a 403", () => {
    expect(isSealedCredentialFailure(new ProviderRejectedError(403, "nope"))).toBe(true);
  });

  test("does not treat other rejections as sealed", () => {
    expect(isSealedCredentialFailure(new ProviderRejectedError(500, "boom"))).toBe(false);
    expect(isSealedCredentialFailure(new Error("Could not reach it"))).toBe(false);
  });
});

describe("requireDiscoveredModels", () => {
  test("passes for a non-empty list", () => {
    expect(() => requireDiscoveredModels(["gpt-5.5"])).not.toThrow();
  });

  test("throws for an empty list", () => {
    expect(() => requireDiscoveredModels([])).toThrow("The provider returned no models; nothing was changed.");
  });
});
