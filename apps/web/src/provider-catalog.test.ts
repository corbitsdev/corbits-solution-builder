import { describe, expect, test } from "bun:test";
import { CODEX_DEFAULT_MODELS } from "@corbits/codex-provider";
import {
  droppedSelection,
  isSealedCredentialFailure,
  missingOAuthModels,
  ProviderRejectedError,
  rejectionMessage,
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

describe("missingOAuthModels", () => {
  test("names the models a Codex connection made with one model lacks", () => {
    expect(missingOAuthModels("codex-oauth", ["gpt-5.6-sol"])).toEqual(CODEX_DEFAULT_MODELS.filter((name) => name !== "gpt-5.6-sol"));
  });

  test("is empty once the connection has every model", () => {
    expect(missingOAuthModels("codex-oauth", [...CODEX_DEFAULT_MODELS])).toEqual([]);
  });

  test("is empty for a provider that is not a sign-in", () => {
    expect(missingOAuthModels("anthropic", [])).toEqual([]);
  });
});

describe("rejectionMessage", () => {
  test("shows the provider's error.message when the body has one", () => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    expect(rejectionMessage(401, body)).toBe("The provider rejected this key (HTTP 401): invalid x-api-key");
  });

  test("falls back to the start of the raw body", () => {
    expect(rejectionMessage(502, `Bad Gateway ${"x".repeat(300)}`)).toBe(
      `The provider rejected this key (HTTP 502): Bad Gateway ${"x".repeat(188)}`,
    );
  });

  test("says only the status for an empty body", () => {
    expect(rejectionMessage(500, "")).toBe("The provider rejected this key (HTTP 500).");
  });
});
