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
/** A number or a letter: a list that is counting is offering. */
const COUNTED = /^\s*\(?(?:\d{1,2}|[a-hA-H])[.)]\s+/;
/** The kit's own form. Only the bare prefix goes; "Option A:" is kept, it is the name. */
const KIT_PREFIX = /^option:\s*/i;
const NAMED = /^option\b/i;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/**
 * A list item, and whether it is unmistakably a choice. A plain bullet is
 * not: a specialist's digest is bulleted too, and a summary under "Anything
 * to change?" was becoming a row of buttons. A bullet that says "Option",
 * or any numbered or lettered item, is.
 */
function itemOf(line: string): { text: string; offered: boolean } | null {
  // Bold is decoration on any part of the item, the marker included.
  const bare = line.replaceAll("**", "");
  if (!MARKER.test(bare)) return null;
  const body = bare.replace(MARKER, "").trim();
  const text = body.replace(KIT_PREFIX, "");
  if (text.length === 0) return null;
  return { text, offered: COUNTED.test(bare) || NAMED.test(body) };
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
  let offered = true;
  while (at > 0 && !blank(at - 1)) {
    const item = itemOf(lines[at - 1]!);
    if (item === null) break;
    options.unshift(item.text);
    offered &&= item.offered;
    at--;
  }
  if (!offered || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;

  if (closing !== null) {
    return { before: lines.slice(0, at).join("\n").trimEnd(), question: closing, options };
  }

  // The paragraph above the list is the question. It asks somewhere in it,
  // not necessarily at its end: the kit wants a clause on why the answer
  // matters, and a specialist often makes that clause its own sentence, so
  // "…serve? It decides the scope." is a question that ends in a full stop.
  let end_ = at;
  while (end_ > 0 && blank(end_ - 1)) end_--;
  let start = end_;
  while (start > 0 && !blank(start - 1) && itemOf(lines[start - 1]!) === null) start--;
  const asked = lines.slice(start, end_).join("\n").trim();
  if (!asked.includes("?")) return null;
  return { before: lines.slice(0, start).join("\n").trimEnd(), question: asked, options };
}
