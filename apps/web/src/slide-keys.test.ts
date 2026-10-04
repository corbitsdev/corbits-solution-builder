import { describe, expect, test } from "bun:test";
import { playerKeyAction, previewKeyAction, slideIndexFor } from "./slide-keys.ts";

describe("slideIndexFor", () => {
  test("arrows and paging move one slide, Home and End to the ends, and nothing past them", () => {
    expect(slideIndexFor("ArrowRight", 0, 5)).toBe(1);
    expect(slideIndexFor("ArrowLeft", 0, 5)).toBeNull();
    expect(slideIndexFor("ArrowLeft", 3, 5)).toBe(2);
    expect(slideIndexFor("End", 1, 5)).toBe(4);
    expect(slideIndexFor("Home", 4, 5)).toBe(0);
    expect(slideIndexFor("PageDown", 4, 5)).toBeNull();
    expect(slideIndexFor("a", 2, 5)).toBeNull();
    expect(slideIndexFor("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("preview and player keys", () => {
  test("Space or Enter on the strip plays; arrows move", () => {
    expect(previewKeyAction(" ", 2, 5)).toEqual({ kind: "play" });
    expect(previewKeyAction("Enter", 2, 5)).toEqual({ kind: "play" });
    expect(previewKeyAction("ArrowRight", 2, 5)).toEqual({ kind: "move", index: 3 });
    expect(previewKeyAction("x", 2, 5)).toBeNull();
  });

  test("in the player Space advances, Escape closes, and the last slide stays put", () => {
    expect(playerKeyAction(" ", 2, 5)).toEqual({ kind: "move", index: 3 });
    expect(playerKeyAction(" ", 4, 5)).toBeNull();
    expect(playerKeyAction("Escape", 4, 5)).toEqual({ kind: "close" });
    expect(playerKeyAction("ArrowLeft", 4, 5)).toEqual({ kind: "move", index: 3 });
  });
});
