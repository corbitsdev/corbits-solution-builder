import { describe, expect, test } from "bun:test";
import { retryAfterReviewError } from "./panel-reviews.tsx";

describe("retryAfterReviewError", () => {
  test("retry after send failure calls requestReview even if a recorded node exists", () => {
    const calls: string[] = [];
    retryAfterReviewError({
      sendFailed: true,
      requestReview: () => calls.push("requestReview"),
      reread: () => calls.push("reread"),
    });
    expect(calls).toEqual(["requestReview"]);
  });

  test("retry after a recovery read failure re-reads", () => {
    const calls: string[] = [];
    retryAfterReviewError({
      sendFailed: false,
      requestReview: () => calls.push("requestReview"),
      reread: () => calls.push("reread"),
    });
    expect(calls).toEqual(["reread"]);
  });
});
