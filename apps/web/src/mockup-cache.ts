/**
 * The design's screens, drawn once per design text and kept for the session
 * (#751). Drawing them is the slow part of every download, slide deck and
 * PRD-for-people page: each screen is rasterised, encoded, decoded, framed
 * and encoded again. The same design text always draws the same pictures,
 * so the work is shared by whoever asks first.
 */
import { framedMockupShots } from "./mockup-frames.ts";
import type { MockupShot } from "./mockup-shots.ts";

const drawn = new Map<string, Promise<MockupShot[]>>();

/** FNV-1a over the text: a cheap, stable key for a design's content. */
export function designKey(html: string, max: number): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < html.length; at += 1) {
    hash ^= html.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${String(max)}:${String(html.length)}:${hash.toString(16)}`;
}

/** The framed screens of a design, drawn once; a drawing that fails is not kept. */
export function cachedFramedMockupShots(html: string, max = 12, draw: (html: string, max: number) => Promise<MockupShot[]> = framedMockupShots): Promise<MockupShot[]> {
  const key = designKey(html, max);
  const held = drawn.get(key);
  if (held) return held;
  const drawing = draw(html, max).catch((cause: unknown) => {
    drawn.delete(key);
    throw cause;
  });
  drawn.set(key, drawing);
  return drawing;
}

/** For tests: forget every drawing. */
export function forgetDrawnScreens(): void {
  drawn.clear();
}
