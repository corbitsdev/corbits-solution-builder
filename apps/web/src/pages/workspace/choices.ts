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

/** A specialist's turn, cut into what it tells and what it asks: prose as
 *  markdown, and each question with the options offered for it. */
export type TurnSegment =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "question"; readonly question: string; readonly options: readonly string[] };

/**
 * Every question a turn asks, each with its own options, in the order asked.
 *
 * The kit puts questions to the reader one at a time, but a specialist that
 * lists two under "What I need from you" -- each with its "- Option:" lines
 * -- has still asked two. Reading only the last (`choicesIn`) leaves the
 * first as bullets nobody can tap: a control that is missing. So each
 * offered list is paired with the question above it, or the "Which one?"
 * closing it, and what lies between is kept as prose. A closing paragraph
 * that only asks, with no options, is a question too.
 */
export function segmentsIn(text: string): TurnSegment[] {
  const lines = text.split("\n");
  const blank = (at: number) => (lines[at] ?? "").trim() === "";
  const segments: TurnSegment[] = [];
  let cursor = 0;
  const flushText = (upTo: number) => {
    const markdown = lines.slice(cursor, upTo).join("\n").trim();
    if (markdown) segments.push({ kind: "text", markdown });
  };

  let at = 0;
  while (at < lines.length) {
    if (blank(at) || itemOf(lines[at]!) === null) {
      at++;
      continue;
    }
    // A run of list items.
    const start = at;
    let end = at;
    const options: string[] = [];
    let offered = true;
    while (end < lines.length && !blank(end)) {
      const item = itemOf(lines[end]!);
      if (item === null) break;
      options.push(item.text);
      offered &&= item.offered;
      end++;
    }
    if (!offered || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      at = end;
      continue;
    }
    // The question above the list: the paragraph directly over it, asking.
    let qEnd = start;
    while (qEnd > cursor && blank(qEnd - 1)) qEnd--;
    let qStart = qEnd;
    while (qStart > cursor && !blank(qStart - 1) && itemOf(lines[qStart - 1]!) === null) qStart--;
    const above = lines.slice(qStart, qEnd).join("\n").trim();
    if (above.includes("?")) {
      flushText(qStart);
      segments.push({ kind: "question", question: above, options });
      cursor = end;
      at = end;
      continue;
    }
    // Or the question closing the list: "Which one?"
    let cEnd = end;
    while (cEnd < lines.length && blank(cEnd)) cEnd++;
    const closing = (lines[cEnd] ?? "").trim();
    if (cEnd < lines.length && closing.endsWith("?") && itemOf(closing) === null) {
      flushText(start);
      segments.push({ kind: "question", question: closing, options });
      cursor = cEnd + 1;
      at = cEnd + 1;
      continue;
    }
    at = end;
  }

  // What remains: prose, unless its last paragraph only asks.
  const rest = lines.slice(cursor).join("\n").trim();
  if (rest) {
    const cut = rest.lastIndexOf("\n\n");
    const last = (cut >= 0 ? rest.slice(cut + 2) : rest).trim();
    if (last.endsWith("?") && itemOf(last) === null) {
      const lead = cut >= 0 ? rest.slice(0, cut).trim() : "";
      if (lead) segments.push({ kind: "text", markdown: lead });
      segments.push({ kind: "question", question: last, options: [] });
    } else {
      segments.push({ kind: "text", markdown: rest });
    }
  }
  return segments;
}

/** What a tapped option sends. Alone when the turn asked one question, so
 *  the specialist reads back exactly what it offered; when the turn asked
 *  several, named for the question it answers. */
export function answerText(question: string, option: string, several: boolean): string {
  if (!several) return option;
  const asked = question.replace(/\s+/g, " ").trim();
  return `On "${asked}": ${option}`;
}
