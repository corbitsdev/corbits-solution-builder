/**
 * Where the passage comment box opens (#749): under the selected words,
 * aligned with where they start, and kept inside the window. The mouse is
 * released wherever the drag ended, which is often nowhere near the words,
 * so the selection's own bounds anchor the box rather than the pointer.
 */

/** Matches `.sel-pop` in styles.css. */
export const SELECTION_POPOVER_WIDTH = 260;
/** The box as rendered: textarea, its row, padding and border. */
export const SELECTION_POPOVER_HEIGHT = 128;
/** Clear of the words, and of the window's edge. */
export const SELECTION_POPOVER_GAP = 8;

export type Bounds = { readonly left: number; readonly top: number; readonly bottom: number };
export type Viewport = { readonly width: number; readonly height: number };

export function selectionPopoverPosition(selection: Bounds, viewport: Viewport): { x: number; y: number } {
  const gap = SELECTION_POPOVER_GAP;
  const x = Math.max(gap, Math.min(selection.left, viewport.width - SELECTION_POPOVER_WIDTH - gap));
  const below = selection.bottom + gap;
  const fitsBelow = below + SELECTION_POPOVER_HEIGHT + gap <= viewport.height;
  const y = fitsBelow ? below : Math.max(gap, selection.top - gap - SELECTION_POPOVER_HEIGHT);
  return { x, y };
}
