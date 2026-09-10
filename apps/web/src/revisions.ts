/**
 * What changed between two versions of a draft, marked inline in the markdown
 * so the renderer can show it the way a word processor shows tracked changes.
 *
 * The markers are control characters a model never emits: INS…END for added
 * text, DEL…END for removed. Block prefixes (headings, bullets) stay outside
 * the marks so the structure still parses.
 */
import { diffLines, diffWordsWithSpace } from "diff";

export const INS = "\u0001";
export const DEL = "\u0002";
export const END = "\u0003";

const PREFIX = /^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?))/;

/** How much of two lines is the same, by characters kept in a word diff. */
function similarity(before: string, after: string): number {
  const kept = diffWordsWithSpace(before, after)
    .filter((part) => !part.added && !part.removed)
    .reduce((total, part) => total + part.value.length, 0);
  return kept / Math.max(before.length, after.length, 1);
}

/** Word-level marks within one line; block prefixes stay outside the marks. */
function markWords(before: string, after: string): string {
  const prefix = PREFIX.exec(after)?.[1] ?? "";
  const body = diffWordsWithSpace(before.slice((PREFIX.exec(before)?.[1] ?? "").length), after.slice(prefix.length))
    .map((part) => {
      if (part.added) return `${INS}${part.value}${END}`;
      if (part.removed) return `${DEL}${part.value}${END}`;
      return part.value;
    })
    .join("");
  return prefix + body;
}

function markWhole(line: string, mark: string): string {
  if (line.trim().length === 0) return line;
  const prefix = PREFIX.exec(line)?.[1] ?? "";
  return `${prefix}${mark}${line.slice(prefix.length)}${END}`;
}

/**
 * Lines first, words second. A line that was edited shows its words changed; a
 * line that was rewritten shows as one removal and one addition, the way a
 * word processor does — marking every word of a rewrite tells the reader
 * nothing except that it changed.
 */
export function markChanges(previous: string, current: string): string {
  const out: string[] = [];
  const parts = diffLines(previous.replace(/\r\n/g, "\n"), current.replace(/\r\n/g, "\n"));
  const lines = (value: string) => value.replace(/\n$/, "").split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!part.added && !part.removed) {
      out.push(...lines(part.value));
      continue;
    }
    const removed = part.removed ? lines(part.value) : [];
    const next = parts[index + 1];
    const added = part.removed && next?.added ? lines(next.value) : part.added ? lines(part.value) : [];
    if (part.removed && next?.added) index += 1;

    // Each removed line pairs with the first later added line it resembles,
    // in order, so an edited bullet lines up with its edit even when new
    // bullets were inserted between them.
    const pair = new Map<number, number>();
    let from = 0;
    for (const [at, before] of removed.entries()) {
      const found = added.findIndex((after, j) => j >= from && similarity(before, after) >= 0.6);
      if (found === -1) continue;
      pair.set(at, found);
      from = found + 1;
    }
    let r = 0;
    for (const [a, after] of added.entries()) {
      while (r < removed.length && !pair.has(r)) out.push(markWhole(removed[r++]!, DEL));
      if (pair.get(r) === a) out.push(markWords(removed[r++]!, after));
      else out.push(markWhole(after, INS));
    }
    while (r < removed.length) out.push(markWhole(removed[r++]!, DEL));
  }
  return out.join("\n");
}
