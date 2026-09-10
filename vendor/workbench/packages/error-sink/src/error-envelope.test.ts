import { describe, expect, test } from "bun:test";
import { makeErrorEnvelope, parseErrorEnvelope } from "./error-envelope";

describe("error envelope", () => {
  test("makeErrorEnvelope carries code, userMessage, and a generated refId", () => {
    const envelope = makeErrorEnvelope({
      code: "provisioning_failed",
      userMessage: "We're on it. Try again in a moment.",
    });
    expect(envelope.error.code).toBe("provisioning_failed");
    expect(envelope.error.userMessage).toBe(
      "We're on it. Try again in a moment.",
    );
    expect(typeof envelope.error.refId).toBe("string");
    expect(envelope.error.refId.length).toBeGreaterThan(0);
  });

  test("parseErrorEnvelope accepts a well-formed envelope", () => {
    const body = {
      error: { code: "x", userMessage: "y", refId: "z" },
    };
    expect(parseErrorEnvelope(body)).toEqual(body);
  });

  test("parseErrorEnvelope rejects a legacy {code, message} body", () => {
    const body = { error: { code: "x", message: "raw internal detail" } };
    expect(parseErrorEnvelope(body)).toBeUndefined();
  });

  test("parseErrorEnvelope rejects garbage", () => {
    expect(parseErrorEnvelope(null)).toBeUndefined();
    expect(parseErrorEnvelope({})).toBeUndefined();
  });
});
