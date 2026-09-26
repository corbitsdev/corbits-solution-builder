import { describe, expect, test } from "bun:test";
import { classifyHTTPError, createDefaultRetryPolicy } from "@intx/inference";

/**
 * The local patch on `@intx/inference` (patches/@intx%2Finference@0.4.0.patch,
 * corbits-solution-builder#74): a provider's 404 is that source's failure,
 * so the reactor fails over to the next configured source instead of
 * abandoning the call. The reactor treats `fatal`, `context_overflow` and
 * `aborted` as source-invariant; everything else fails over.
 */
describe("a 404 from a provider fails over instead of aborting the chain", () => {
  test("404 is classified as source-specific, with the status kept for the message", () => {
    const error = classifyHTTPError(404, "Not found", { type: "not_found_error" });
    expect(error.category).not.toBe("fatal");
    expect(["protocol_mismatch", "credential_failure", "quota_exhausted", "retryable", "timeout"]).toContain(error.category);
    expect(error.statusCode).toBe(404);
  });

  test("a 404 takes no mechanical retries against the same source", () => {
    const policy = createDefaultRetryPolicy();
    const error = classifyHTTPError(404, "Not found", {});
    expect(policy({ error, attempt: 1, elapsedMs: 0 })).toEqual({ kind: "abort" });
  });

  test("the other classifications are as upstream ships them", () => {
    expect(classifyHTTPError(401, "no", {}).category).toBe("credential_failure");
    expect(classifyHTTPError(429, "slow", {}).category).toBe("quota_exhausted");
    expect(classifyHTTPError(503, "down", {}).category).toBe("retryable");
    expect(classifyHTTPError(418, "teapot", {}).category).toBe("fatal");
  });
});
