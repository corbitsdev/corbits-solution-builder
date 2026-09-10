/**
 * The choices a specialist offers at the end of a turn, found so they can be
 * tapped.
 *
 * The kit asks for "- Option: …" lines under a question, and the interview
 * relies on that form. A specialist proposing bounded options, which is the
 * brainstormer's whole job, does not always keep to it: it numbers them,
 * letters them, bolds them, or closes the list with "Which one?". A choice a
 * person can read but not tap is a control that is missing, so every one of
 * those forms is read here. What is sent when a choice is tapped is the
 * choice as written, less the list marker, so the specialist reads back
 * exactly what it offered.
 */
export type Choices = {
  /** Everything before the question, still markdown. */
  before: string;
  question: string;
  options: string[];
};

/** A bullet, a number, or a letter a to h, with or without brackets. */
const MARKER = /^\s*(?:[-*+•]|\(?(?:\d{1,2}|[a-hA-H])[.)])\s+/;
/** The kit's own form. Only the bare prefix goes; "Option A:" is kept, it is the name. */
const KIT_PREFIX = /^option:\s*/i;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

function itemOf(line: string): string | null {
  // Bold is decoration on any part of the item, the marker included.
  const bare = line.replaceAll("**", "");
  if (!MARKER.test(bare)) return null;
  const text = bare.replace(MARKER, "").trim().replace(KIT_PREFIX, "");
  return text.length > 0 ? text : null;
}

export function choicesIn(text: string): Choices | null {
  const lines = text.split("\n");
  let end = lines.length;
  const blank = (at: number) => (lines[at] ?? "").trim() === "";
  while (end > 0 && blank(end - 1)) end--;

  // A list may close with the question rather than open with it: "Which one?"
  let closing: string | null = null;
  const last = (lines[end - 1] ?? "").trim();
  if (last.endsWith("?") && itemOf(last) === null) {
    closing = last;
    end--;
    while (end > 0 && blank(end - 1)) end--;
  }

  const options: string[] = [];
  let at = end;
  while (at > 0 && !blank(at - 1)) {
    const item = itemOf(lines[at - 1]!);
    if (item === null) break;
    options.unshift(item);
    at--;
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;

  let above = at;
  while (above > 0 && blank(above - 1)) above--;
  const asked = (lines[above - 1] ?? "").trim();
  if (closing !== null) {
    return { before: lines.slice(0, at).join("\n").trimEnd(), question: closing, options };
  }
  if (!asked.endsWith("?") || itemOf(asked) !== null) return null;
  return { before: lines.slice(0, above - 1).join("\n").trimEnd(), question: asked, options };
}
