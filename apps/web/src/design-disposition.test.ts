import { describe, expect, test } from "bun:test";
import {
  anchorResolves,
  carryForwardFeedback,
  withDisposition,
  withFallbackIds,
  type Disposition,
} from "./design-disposition.ts";

type Entry = { id: string; disposition?: Disposition; dispositionAt?: string };

describe("anchorResolves", () => {
  test("a stable test id present in the current design resolves", () => {
    expect(anchorResolves({ testId: "submit-btn" }, `<button data-testid="submit-btn">Go</button>`)).toBe(true);
  });

  test("a stable test id absent from the current design does not resolve", () => {
    expect(anchorResolves({ testId: "submit-btn" }, `<button data-testid="cancel-btn">Cancel</button>`)).toBe(false);
  });

  test("a malformed domPath does not resolve", () => {
    expect(anchorResolves({ domPath: "not a valid path" }, `<div>hi</div>`)).toBe(false);
  });

  test("a well-formed domPath whose tag is present resolves", () => {
    expect(anchorResolves({ domPath: "div:nth-child(1) > span:nth-child(2)" }, `<div><span>hi</span></div>`)).toBe(
      true,
    );
  });

  test("an un-anchored comment (the overall note, or the whole design) always resolves", () => {
    expect(anchorResolves({}, `<div>hi</div>`)).toBe(true);
  });
});

describe("withDisposition", () => {
  test("sets only the targeted entry's disposition", () => {
    const entries: Entry[] = [{ id: "a" }, { id: "b" }];
    const updated = withDisposition(entries, "b", "addressed", "2026-01-01T00:00:00.000Z");
    expect(updated[0]).toEqual({ id: "a" });
    expect(updated[1]).toEqual({ id: "b", disposition: "addressed", dispositionAt: "2026-01-01T00:00:00.000Z" });
  });
});

describe("carryForwardFeedback", () => {
  test("a new design version leaves every disposition untouched", () => {
    const entries = [
      { id: "a", disposition: "addressed" as const, dispositionAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", disposition: "open" as const },
    ];
    expect(carryForwardFeedback(entries)).toEqual(entries);
  });
});

type CommentEntry = { id?: string; text: string };

describe("withFallbackIds", () => {
  test("keeps a real id and marks the row addressable", () => {
    const [result] = withFallbackIds<CommentEntry>([{ id: "real-1", text: "hi" }], "node");
    expect(result).toEqual({ id: "real-1", text: "hi", addressable: true });
  });

  test("gives a legacy id-less row a positional fallback id and marks it unaddressable", () => {
    const [result] = withFallbackIds<CommentEntry>([{ text: "an old comment" }], "node");
    expect(result).toEqual({ text: "an old comment", id: "node:legacy:0", addressable: false });
  });
});
