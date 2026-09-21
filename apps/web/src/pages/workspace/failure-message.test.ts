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

  test("frames a plain Error as recoverable, keeping its detail", () => {
    expect(describeFailure(new Error("network dropped"))).toBe(
      "Something could not be completed: network dropped Nothing was lost — try again.",
    );
  });

  test("frames a thrown string the same way", () => {
    expect(describeFailure("boom")).toBe("Something could not be completed: boom Nothing was lost — try again.");
  });

  test("falls back calmly when there is no detail to show", () => {
    expect(describeFailure({ weird: true })).toBe(
      "Something could not be completed, and no detail was recorded. Nothing was lost — try again.",
    );
    expect(describeFailure(42)).toBe(
      "Something could not be completed, and no detail was recorded. Nothing was lost — try again.",
    );
    expect(describeFailure(new Error("   "))).toBe(
      "Something could not be completed, and no detail was recorded. Nothing was lost — try again.",
    );
  });
});
