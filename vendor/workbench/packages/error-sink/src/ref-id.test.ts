import { describe, expect, test } from "bun:test";
import { generateRefId } from "./ref-id";

describe("generateRefId", () => {
  test("produces a non-empty string", () => {
    const refId = generateRefId();
    expect(typeof refId).toBe("string");
    expect(refId.length).toBeGreaterThan(0);
  });

  test("is not constant across calls", () => {
    expect(generateRefId()).not.toBe(generateRefId());
  });
});
