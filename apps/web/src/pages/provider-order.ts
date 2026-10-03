/**
 * The order of the connected providers, as pure list moves.
 *
 * The order is the whole rule: the first provider with a model enabled is the
 * primary (`setProviderOrder` re-bases every provider's offering priorities
 * into rank-sized blocks, so the catalog's fallback order and the deploy-time
 * model follow it). "Make primary" reduces to `moveTo(order, id, 0)`.
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

export const PRIMARY = "Primary";

/** What a row's place among the providers with a model enabled means, in the
 *  person's words: the first is the primary; each one after it is tried if
 *  the one above fails. `null` for a row with no model enabled: it is skipped. */
export function rankLabel(position: number, hasModel: boolean): string | null {
  if (!hasModel) return null;
  if (position === 0) return PRIMARY;
  const n = position + 1;
  const suffix = n === 2 ? "nd" : n === 3 ? "rd" : "th";
  return `Tried ${n}${suffix} if the one above fails`;
}
