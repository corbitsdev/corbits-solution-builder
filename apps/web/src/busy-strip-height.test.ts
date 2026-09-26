import { describe, expect, test } from "bun:test";
import { STRIP_MIN_HEIGHT, clampStripHeight, draggedStripHeight } from "./busy-strip-height.ts";

// #120: dragging the strip's top edge sets its height, within bounds.
describe("the busy strip's height", () => {
  test("a drag upward makes it taller, downward shorter, pixel for pixel", () => {
    expect(draggedStripHeight(120, 700, 650, 900)).toBe(170);
    expect(draggedStripHeight(120, 700, 740, 900)).toBe(80);
  });

  test("never shorter than the minimum, never more than its share of the window", () => {
    expect(draggedStripHeight(120, 700, 900, 900)).toBe(STRIP_MIN_HEIGHT);
    expect(draggedStripHeight(120, 700, 0, 900)).toBe(540);
    expect(clampStripHeight(10_000, 500)).toBe(300);
  });

  test("a tiny window still allows the minimum", () => {
    expect(clampStripHeight(40, 60)).toBe(STRIP_MIN_HEIGHT);
  });
});
