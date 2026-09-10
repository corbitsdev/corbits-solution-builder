/**
 * Reading a drafted document.
 *
 * A stage prompt ends by asking the specialist for the one thing it needs to
 * know. That question is the next turn of the conversation, so the host lifts
 * it out of the draft and speaks it: a question sitting unread under a heading
 * has not been asked.
 */

/**
 * The digest a specialist opens its draft with.
 *
 * The conversation speaks this rather than announcing that a version exists.
 * A stage that opens on "Nothing said yet" leaves a person looking at an empty
 * screen beside a document nobody has told them anything about.
 */
export function summaryIn(document: string): string | null {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^#{1,4}\s+in short\b/i.test(line.trim()));
  if (start === -1) return null;

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** What a specialist filled in for itself, lifted from its own heading. */
export function assumptionsIn(document: string): string[] {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) =>
    /^#{1,4}\s+(what i assumed|assumptions)\b/i.test(line.trim()),
  );
  if (start === -1) return [];

  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    const item = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (item.length === 0) continue;
    if (/^_?(none|nothing|n\/a)\b/i.test(item)) return [];
    found.push(item.length > 400 ? `${item.slice(0, 400)}…` : item);
  }
  return found.slice(0, 12);
}

/** Every question a specialist ended its draft with, in the order asked. */
export function questionsIn(document: string): string[] {
  const lines = document.split("\n");
  const start = lines.findIndex((line) =>
    /^#{1,4}\s+(open questions?\b|what i need\b|the one thing i need\b)/i.test(line.trim()),
  );
  if (start === -1) return [];

  const questions: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    const item = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (item.length === 0) continue;
    // A section that says there is nothing to ask is answering, not asking.
    if (/^_?(none|nothing|n\/a)\b/i.test(item)) return [];
    questions.push(item.length > 400 ? `${item.slice(0, 400)}…` : item);
  }
  return questions.slice(0, 8);
}

/** The first of them, for a caller that only wants the opening turn. */
export function questionIn(document: string): string | null {
  return questionsIn(document)[0] ?? null;
}
