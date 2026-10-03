import { screenNamesOf } from "./mockup-shots.ts";
import { isHtmlDocument } from "./pages/workspace/guidance.ts";

/**
 * How an approved design is handed to the next stage's specialist (#219).
 *
 * A stage 4 design is usually an HTML mockup: a whole document with styles
 * and markup, which the design page shows in a sandboxed frame. Mailed
 * verbatim to the presentation creator it is 30 KB of markup with no prose
 * in it, and the model answers in kind -- an HTML rewrite rather than the
 * Markdown package its role requires. So an HTML design goes over as the
 * text a person reads off it: its title and headings as Markdown headings,
 * its lists as lists, its copy as paragraphs, tags and styles gone, in a
 * fenced block that says what it is, with a line saying the full design is
 * the stage 4 artifact of record. A Markdown design passes through as is.
 */
/** The line that opens the design's text in a hand-off; what the transcript folds on (#301). */
export const HANDOFF_LEAD = "The approved design is an HTML mockup, on record as the GUI design artifact. Its text, for reference:";

export function designHandoff(design: string): string {
  if (!isHtmlDocument(design)) return design;
  // The screens by name, so a slide may ask for one (#302).
  const screens = screenNamesOf(design);
  const naming = screens.length > 0 ? [`Its screens, which a slide may name as (screen: <name>): ${screens.join(", ")}.`, ""] : [];
  return [HANDOFF_LEAD, "", ...naming, "```text", designAsText(design), "```"].join("\n");
}

/**
 * A message that carries a design hand-off, split for the transcript
 * (#301): what was asked, and the design's text to fold away. Null for
 * any other message.
 */
export function splitHandoff(text: string): { readonly lead: string; readonly attached: string } | null {
  const at = text.indexOf(HANDOFF_LEAD);
  if (at === -1) return null;
  return { lead: text.slice(0, at).trim(), attached: text.slice(at).trim() };
}

/** How much of a design's text goes into a mail: enough for every screen's copy, not a whole product's. */
export const DESIGN_TEXT_CAP = 12_000;

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * The readable text of an HTML document, as Markdown: `<title>` and
 * `<h1>`..`<h6>` become headings, `<li>` items become list items, block
 * elements break paragraphs, everything else loses its tags. Scripts,
 * styles and comments are dropped whole. Capped at `cap` characters with a
 * note saying so, since a mockup's copy can run long.
 */
export function designAsText(html: string, cap = DESIGN_TEXT_CAP): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, "");
  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, " ")}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|ul|ol|li|tr|table|blockquote|pre|figure|figcaption|dl|dt|dd|form|fieldset|label|button|h[1-6])>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const titled = title && !text.startsWith(`# ${title}`) ? `# ${decodeEntities(title)}\n\n${text}` : text;
  if (titled.length <= cap) return titled;
  return `${titled.slice(0, cap).trimEnd()}\n\n[… the design's text continues; the full mockup is the GUI design artifact]`;
}
