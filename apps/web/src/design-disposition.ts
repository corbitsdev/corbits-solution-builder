/**
 * Pure helpers for stage-4 feedback disposition — CL-8699. Nothing here
 * touches the artifact store; the client writes a disposition through the
 * same metadata-revise path `submitDesignFeedback` already uses.
 */
import type { DesignFeedbackDisposition } from "@solutions-builder/app/artifact-graph";

export type Disposition = DesignFeedbackDisposition;

export type AnchorLike = {
  readonly testId?: string;
  readonly domPath?: string;
};

type DispositionEntry = {
  readonly id?: string;
  readonly disposition?: Disposition;
  readonly dispositionAt?: string;
};

const DOM_PATH_SEGMENT = /^[a-z][a-z0-9-]*:nth-child\(\d+\)$/i;

function domPathWellFormed(domPath: string): boolean {
  const segments = domPath.split(" > ").filter(Boolean);
  return segments.length > 0 && segments.every((segment) => DOM_PATH_SEGMENT.test(segment));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a comment's anchor can still be found in a design version's HTML.
 * A stable test id must appear as an `id`, `data-testid` or `data-test-id`
 * attribute value; a DOM-path anchor is checked by its last segment's tag
 * name, since verifying the full chain would need a real DOM, not an HTML
 * string. A domPath that does not parse never resolves. An anchor with
 * neither is not anchored to anything (the overall note, or the whole
 * design) and always resolves — there is nothing on it that can go stale.
 */
export function anchorResolves(anchor: AnchorLike, designHtml: string): boolean {
  if (anchor.testId) {
    const pattern = new RegExp(`(?:id|data-testid|data-test-id)=["']${escapeRegExp(anchor.testId)}["']`);
    return pattern.test(designHtml);
  }
  if (anchor.domPath) {
    if (!domPathWellFormed(anchor.domPath)) return false;
    const lastSegment = anchor.domPath.split(" > ").at(-1)!;
    const tag = lastSegment.split(":")[0];
    return new RegExp(`<${tag}[\\s>]`, "i").test(designHtml);
  }
  return true;
}

/**
 * A short, deterministic, non-cryptographic hash for labeling a revision
 * prompt's text in the feedback table — not a content-integrity hash, just a
 * stable label so two prompts are visibly different at a glance.
 */
export function shortPromptHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Sets one comment's disposition by id, leaving every other entry untouched. */
export function withDisposition<T extends DispositionEntry>(
  entries: readonly T[],
  entryId: string,
  disposition: Disposition,
  at: string,
): T[] {
  return entries.map((entry) => (entry.id === entryId ? { ...entry, disposition, dispositionAt: at } : entry));
}

/**
 * What a new design version does to existing feedback dispositions: nothing.
 * A version is a new artifact write on its own node — it never revises the
 * feedback array of the node(s) it was reviewed against, so this fold is the
 * identity function. Named and exported so that invariant is checked, not
 * assumed.
 */
export function carryForwardFeedback<T extends DispositionEntry>(entries: readonly T[]): readonly T[] {
  return entries;
}

/**
 * Gives every entry a stable id to render and key by, even a row written
 * before ids existed (a legacy `sb.feedback` entry has none). A fallen-back
 * id is positional, not persisted, and never matches a real id, so
 * `addressable` is false for it — `withDisposition` cannot target a row that
 * was never given a real id, and the caller should disable that row's
 * disposition control rather than let a write silently do nothing.
 */
export function withFallbackIds<T extends { id?: string }>(
  entries: readonly T[],
  keyPrefix: string,
): (T & { id: string; addressable: boolean })[] {
  return entries.map((entry, index) => ({
    ...entry,
    id: entry.id ?? `${keyPrefix}:legacy:${index}`,
    addressable: entry.id !== undefined,
  }));
}
