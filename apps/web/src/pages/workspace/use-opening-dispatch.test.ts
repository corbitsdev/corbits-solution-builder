import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../../client.js";
import { openingFailure, openingFailureWhat } from "./use-opening-dispatch.ts";

const readError = new ApiFailure({
  code: "not_found",
  message: "the chain could not be read",
  correlationId: "c1",
  retryable: true,
});

describe("openingFailureWhat", () => {
  test("names a send only as a send, and a read as a read", () => {
    expect(openingFailureWhat("send")).toBe("Couldn't send the opening message");
    expect(openingFailureWhat("opening")).toBe("Couldn't load the opening");
    expect(openingFailureWhat("chain")).toBe("Couldn't load the previous stages");
    expect(openingFailureWhat("package")).toBe("Couldn't load the package");
  });
});

describe("openingFailure", () => {
  test("a send failure on an empty thread is a send", () => {
    const result = openingFailure({
      sendError: "mailbox refused",
      openingError: undefined,
      chainError: undefined,
      packageError: undefined,
      threadHasOpening: false,
      sendBackCue: false,
    });
    expect(result).toEqual({ error: "mailbox refused", kind: "send" });
  });

  test("a chain read on a nonempty thread is not a send", () => {
    const result = openingFailure({
      sendError: null,
      openingError: undefined,
      chainError: readError,
      packageError: undefined,
      threadHasOpening: true,
      sendBackCue: false,
    });
    expect(result?.kind).toBe("chain");
    expect(result?.error).toBe("the chain could not be read");
  });

  test("a send-back cue failure on a nonempty thread still surfaces", () => {
    const result = openingFailure({
      sendError: "mailbox refused the send-back cue",
      openingError: undefined,
      chainError: undefined,
      packageError: undefined,
      threadHasOpening: true,
      sendBackCue: true,
    });
    expect(result).toEqual({ error: "mailbox refused the send-back cue", kind: "send" });
  });

  test("a send-opening failure on a nonempty thread is dropped", () => {
    expect(
      openingFailure({
        sendError: "mailbox refused",
        openingError: undefined,
        chainError: undefined,
        packageError: undefined,
        threadHasOpening: true,
        sendBackCue: false,
      }),
    ).toBeNull();
  });

  test("an opening read on an empty thread is named as a load", () => {
    const result = openingFailure({
      sendError: null,
      openingError: readError,
      chainError: undefined,
      packageError: undefined,
      threadHasOpening: false,
      sendBackCue: false,
    });
    expect(result?.kind).toBe("opening");
  });

  test("a package read is named as a package load", () => {
    const result = openingFailure({
      sendError: null,
      openingError: undefined,
      chainError: undefined,
      packageError: readError,
      threadHasOpening: true,
      sendBackCue: false,
    });
    expect(result?.kind).toBe("package");
    expect(openingFailureWhat(result!.kind)).toBe("Couldn't load the package");
  });
});
