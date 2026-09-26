/**
 * The busy strip's height, when a person has set one (#120).
 *
 * Dragging the strip's top edge sets it; the arrow keys on the grip do the
 * same for a keyboard; a double-click on the grip lets it go back to the
 * default. Kept in this browser's storage, since it is a preference for
 * this window and nothing the host needs to know. The rules are pure so
 * the drag arithmetic and the bounds are testable without a pointer.
 */

export const STRIP_HEIGHT_KEY = "solutions-builder-busy-strip-height";
export const STRIP_MIN_HEIGHT = 56;
/** Never more than this share of the window: the strip is a strip. */
export const STRIP_MAX_SHARE = 0.6;
export const STRIP_KEY_STEP = 8;

export function clampStripHeight(px: number, viewportHeight: number): number {
  const max = Math.max(STRIP_MIN_HEIGHT, Math.floor(viewportHeight * STRIP_MAX_SHARE));
  return Math.min(max, Math.max(STRIP_MIN_HEIGHT, Math.round(px)));
}

/** The height a drag has reached: the edge moves with the pointer, up being taller. */
export function draggedStripHeight(startHeight: number, startY: number, y: number, viewportHeight: number): number {
  return clampStripHeight(startHeight + (startY - y), viewportHeight);
}

export function readStripHeight(): number | null {
  try {
    const raw = localStorage.getItem(STRIP_HEIGHT_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= STRIP_MIN_HEIGHT ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStripHeight(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(STRIP_HEIGHT_KEY);
    else localStorage.setItem(STRIP_HEIGHT_KEY, String(px));
  } catch {
    // A private window or blocked storage: the height still holds for this session.
  }
}
