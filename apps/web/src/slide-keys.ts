/**
 * The keys the slides preview and its player answer to (#662), as pure
 * rules: which slide a key moves to, and whether a key plays or closes.
 */
export type SlideKeyAction = { readonly kind: "move"; readonly index: number } | { readonly kind: "play" } | { readonly kind: "close" } | null;

/** The slide a key lands on from `index` of `count`; null when the key means nothing here or there is nowhere to go. */
export function slideIndexFor(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  let next: number;
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      next = index - 1;
      break;
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      next = index + 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = last;
      break;
    default:
      return null;
  }
  const clamped = Math.max(0, Math.min(last, next));
  return clamped === index ? null : clamped;
}

/** What a key does on the strip or the main slide: move, play, or nothing. */
export function previewKeyAction(key: string, index: number, count: number): SlideKeyAction {
  if (key === " " || key === "Spacebar" || key === "Enter") return { kind: "play" };
  const moved = slideIndexFor(key, index, count);
  return moved === null ? null : { kind: "move", index: moved };
}

/** What a key does in the player: Space advances, Escape closes, the rest move. */
export function playerKeyAction(key: string, index: number, count: number): SlideKeyAction {
  if (key === "Escape") return { kind: "close" };
  if (key === " " || key === "Spacebar") {
    const moved = slideIndexFor("ArrowRight", index, count);
    return moved === null ? null : { kind: "move", index: moved };
  }
  const moved = slideIndexFor(key, index, count);
  return moved === null ? null : { kind: "move", index: moved };
}
