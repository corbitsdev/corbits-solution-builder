/**
 * Reordering the connected providers, as pure list moves.
 *
 * The order is the whole rule: the provider at the head is where the default
 * model comes from (`setProviderOrder` re-bases every provider's offering
 * priorities into rank-sized blocks, so the catalog's fallback order and the
 * deploy-time default follow it). Dragging, the arrow keys on a row's handle
 * and "Use as default" all reduce to these moves.
 */

/** `id` moved to `index`, clamped to the list; unknown ids leave it alone. */
export function moveTo(order: readonly string[], id: string, index: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const next = order.filter((entry) => entry !== id);
  const at = Math.max(0, Math.min(index, next.length));
  next.splice(at, 0, id);
  return next;
}

/** `id` moved by `delta` places (negative is up). */
export function moveBy(order: readonly string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  return moveTo(order, id, from + delta);
}

/** `draggedId` dropped onto `targetId`: it takes the target's place, the
 *  target and what follows shift down. Dropping onto itself changes nothing. */
export function dropOn(order: readonly string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return [...order];
  const target = order.indexOf(targetId);
  if (target < 0 || !order.includes(draggedId)) return [...order];
  const without = order.filter((entry) => entry !== draggedId);
  const at = without.indexOf(targetId);
  without.splice(at, 0, draggedId);
  return without;
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** What the order needs to know about a connected provider. */
export type OrderedProvider = {
  readonly id: string;
  /** The block its offering priorities live in (`floor(priority / 1000)`). */
  readonly priority: number;
  /** Its model that would draft, or null when none of its offerings is enabled. */
  readonly selectedModel: string | null;
};

/**
 * The provider the default model comes from: the first in order that has an
 * enabled model. A provider whose every offering is disabled has nothing to
 * draft with, so the default falls through it to the next.
 */
export function defaultProviderId(order: readonly string[], providers: readonly OrderedProvider[]): string | null {
  for (const id of order) {
    const provider = providers.find((entry) => entry.id === id);
    if (provider && provider.selectedModel !== null) return id;
  }
  return null;
}

/**
 * Whether two connected providers share a priority block. Blocks are what
 * make provider order mean anything -- a saved order re-bases each
 * provider's offerings into `rank * 1000 + offset` -- and two providers
 * connected before any order was ever saved both start in block 0. Then
 * the list's tie-break and the catalog's lowest-priority pick can disagree
 * about which provider is first; saving the order as shown settles it.
 */
export function blocksCollide(providers: readonly OrderedProvider[]): boolean {
  const seen = new Set<number>();
  for (const provider of providers) {
    if (seen.has(provider.priority)) return true;
    seen.add(provider.priority);
  }
  return false;
}

/** What a row's place in the order means, in the person's words: the head
 *  is the default and is tried first; each row below is tried if the one
 *  above fails. `null` for a row that has no model enabled: it is skipped. */
export function rankLabel(position: number, hasModel: boolean): string | null {
  if (!hasModel) return null;
  if (position === 0) return "Default · tried first";
  const n = position + 1;
  const suffix = n === 2 ? "nd" : n === 3 ? "rd" : "th";
  return `Tried ${n}${suffix} if the one above fails`;
}
