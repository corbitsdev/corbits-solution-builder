import { describe, expect, test } from "bun:test";
import {
  SELECTION_POPOVER_GAP as GAP,
  SELECTION_POPOVER_HEIGHT as HEIGHT,
  SELECTION_POPOVER_WIDTH as WIDTH,
  selectionPopoverPosition,
} from "./selection-popover.ts";

// #749: the box used to open at the mouse-release point, which for a drag
// that ends away from the words is nowhere near them.
describe("selectionPopoverPosition", () => {
  const viewport = { width: 1400, height: 900 };

  test("a short selection in the middle of the page gets the box just under it, aligned with its start", () => {
    expect(selectionPopoverPosition({ left: 300, top: 400, bottom: 420 }, viewport)).toEqual({ x: 300, y: 420 + GAP });
  });

  test("a selection across several lines hangs the box under its last line, at the block's left edge", () => {
    expect(selectionPopoverPosition({ left: 150, top: 200, bottom: 290 }, viewport)).toEqual({ x: 150, y: 290 + GAP });
  });

  test("near the right edge the box is pulled left so it stays inside the window", () => {
    const { x } = selectionPopoverPosition({ left: 1300, top: 400, bottom: 420 }, viewport);
    expect(x).toBe(viewport.width - WIDTH - GAP);
  });

  test("near the left edge the box keeps a margin from the window", () => {
    expect(selectionPopoverPosition({ left: -20, top: 400, bottom: 420 }, viewport).x).toBe(GAP);
  });

  test("with no room below, the box opens above the selection instead", () => {
    const { y } = selectionPopoverPosition({ left: 300, top: 840, bottom: 860 }, viewport);
    expect(y).toBe(840 - GAP - HEIGHT);
    expect(y + HEIGHT).toBeLessThan(840);
  });

  test("a selection ending exactly where the box still fits stays below", () => {
    const bottom = viewport.height - HEIGHT - 2 * GAP;
    expect(selectionPopoverPosition({ left: 300, top: bottom - 20, bottom }, viewport).y).toBe(bottom + GAP);
  });

  test("in the bottom-right corner it goes above and is pulled left at once", () => {
    const pos = selectionPopoverPosition({ left: 1390, top: 880, bottom: 895 }, viewport);
    expect(pos).toEqual({ x: viewport.width - WIDTH - GAP, y: 880 - GAP - HEIGHT });
  });

  test("in a window too short for either side, the box is pinned to the top margin", () => {
    expect(selectionPopoverPosition({ left: 10, top: 40, bottom: 60 }, { width: 600, height: 150 }).y).toBe(GAP);
  });
});
