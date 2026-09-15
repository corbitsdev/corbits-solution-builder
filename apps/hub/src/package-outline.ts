/**
 * What a stakeholder's package must carry: the deck outline its slides are
 * built from. Read here, without the deck renderer, so the artifact writer
 * can refuse a package that has none — whoever wrote it, the presentation
 * creator or a person — before it becomes a version.
 */
import { DECK_DENSITY, DEFAULT_DECK_DESIGN } from "@solutions-builder/app/deck";

export type DeckSlide = {
  readonly title: string;
  readonly bullets: readonly string[];
  readonly notes: string;
};

/** The heading a package's slides are read from. */
export const OUTLINE_HEADING = "Deck outline";

/** The text under a `### heading`, up to the next heading of the same or a higher level. */
function sectionIn(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^###\s+/.test(line) && line.replace(/^###\s+/, "").trim().toLowerCase() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##{1,2}\s+/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Plain text from a line of Markdown: emphasis, code and citation brackets removed. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A body split into the sentences a slide shows, up to `most`; a "Source:" sentence stays in the notes. */
function bulletsOf(body: string, most: number): string[] {
  const text = plain(body).replace(/\s*Source:.*$/i, "");
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.slice(0, most);
}

/**
 * The deck outline's numbered items: each a title in bold and a body under
 * it. An item without bold text takes its whole first line as the title.
 */
export function outlineSlidesIn(markdown: string, most = DECK_DENSITY[DEFAULT_DECK_DESIGN.density]): DeckSlide[] {
  const section = sectionIn(markdown, OUTLINE_HEADING.toLowerCase());
  if (section === null) return [];
  const items: { title: string; body: string[] }[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const head = numbered[1]!;
      const bold = /\*\*(.+?)\*\*/.exec(head);
      const title = plain(bold ? bold[1]! : head);
      const after = bold ? plain(head.slice(head.indexOf(bold[0]) + bold[0].length)) : "";
      items.push({ title, body: after ? [after] : [] });
      continue;
    }
    const current = items.at(-1);
    if (!current) continue;
    if (line.trim() === "") continue;
    current.body.push(line.trim());
  }
  return items
    .filter((item) => item.title.length > 0)
    .map((item) => {
      const body = item.body.join(" ");
      return { title: item.title, bullets: bulletsOf(body, most), notes: plain(body) };
    });
}

/** The decision request's lines, bullets and paragraphs alike, as plain text. */
export function decisionLinesIn(markdown: string): string[] {
  const section = sectionIn(markdown, "decision request");
  if (section === null) return [];
  return section
    .split("\n")
    .map((line) => plain(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")))
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

/**
 * Why a package cannot be one, or null when it can: every package carries a
 * "### Deck outline" section with at least one numbered slide, because that
 * is what its stakeholder's slides are built from. The sentence is written
 * for the person reading the refusal.
 */
export function packageOutlineProblem(markdown: string): string | null {
  if (sectionIn(markdown, OUTLINE_HEADING.toLowerCase()) === null) {
    return `it has no "### ${OUTLINE_HEADING}" section, and a package's slides are built from that outline`;
  }
  if (outlineSlidesIn(markdown).length === 0) {
    return `its "### ${OUTLINE_HEADING}" section has no numbered slides (one per line, "1. **Title** — what the slide says"), and a package's slides are built from those`;
  }
  return null;
}
