import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../../client.js";
import { describeFailure } from "./failure-message.ts";

describe("describeFailure", () => {
  test("returns the hub's message verbatim for an ApiFailure", () => {
    const cause = new ApiFailure({
      code: "deployment_failed",
      message: "The hub answered 502: deployment could not be scheduled.",
      correlationId: "corr-1",
      retryable: true,
    });
    expect(describeFailure(cause)).toBe("The hub answered 502: deployment could not be scheduled.");
  });

  test("returns the message of a plain Error", () => {
    expect(describeFailure(new Error("network dropped"))).toBe("network dropped");
  });

  test("returns a thrown string as-is", () => {
    expect(describeFailure("boom")).toBe("boom");
  });

  test("stringifies anything else", () => {
    expect(describeFailure({ weird: true })).toBe("[object Object]");
    expect(describeFailure(42)).toBe("42");
  });
});
