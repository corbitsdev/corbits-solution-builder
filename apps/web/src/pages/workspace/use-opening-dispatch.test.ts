import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiFailure } from "../../client.js";
import { OpeningReadFailure, describeOpeningFailure } from "./use-opening-dispatch.ts";

const down = new ApiFailure({ code: "unavailable", message: "the hub is down", correlationId: "c1", retryable: true });

describe("describeOpeningFailure", () => {
  test("a read that failed is named as that read, with the hub's reason", () => {
    const failure = describeOpeningFailure(new OpeningReadFailure("Problem discovery's approved document could not be read", down));
    expect(failure).toEqual({ what: "Problem discovery's approved document could not be read", detail: "the hub is down" });
  });

  test("anything else is the send", () => {
    expect(describeOpeningFailure(down)).toEqual({ what: "The opening message could not be sent", detail: "the hub is down" });
    expect(describeOpeningFailure(new Error("socket closed"))).toEqual({ what: "The opening message could not be sent", detail: "socket closed" });
  });
});

// #570: an opening whose read failed was never sent, and nothing said why.
describe("no read on the opening's way is dropped", () => {
  const source = readFileSync(join(import.meta.dir, "use-opening-dispatch.ts"), "utf8");

  test("the previous stage's document, Deliver's compose and the cue's record report their failure", () => {
    expect(source).not.toContain(".catch(() => {})");
    expect(source).not.toContain('.catch(() => "")');
  });

  test("stage 1's opening is a query, so its failure is held and refetched from Try again", () => {
    expect(source).toContain("queryKey: keys.projectOpening.of(detail.project.id)");
    expect(source).toContain("if (opening.error) void opening.refetch();");
  });

  test("the send-back cue's failure is shown and retried, not only cleared", () => {
    const cue = source.slice(source.indexOf("const cueInFlightRef"), source.indexOf("return {", source.indexOf("const cueInFlightRef")));
    expect(cue).toContain('setFailure({ what: "The send-back cue could not be sent"');
    expect(cue).toContain('setFailure({ what: "The record for the send-back cue could not be read"');
    expect(cue).toContain("retryAttempt]);");
  });

  test("the banner says what failed, not always that a send did", () => {
    const index = readFileSync(join(import.meta.dir, "index.tsx"), "utf8");
    expect(index).toContain("title={openingDispatch.failure.what}");
    expect(index).not.toContain('title="The opening message could not be sent"');
  });
});
