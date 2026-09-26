/**
 * The phone screens in a design, lifted out of the document so each can be
 * shown inside a phone of its own (#101).
 *
 * The Experience designer marks a phone screen
 * `<section data-testid="screen-<name>" data-surface="phone">` and draws the
 * screen, not the device. This finds each such section, gives it a document
 * of its own that carries the design's `<head>` — the one `<style>` block
 * every screen shares — and returns the design with those sections removed,
 * so what is not a phone screen (other surfaces, the design notes) still
 * reads in the ordinary frame.
 *
 * Text, not a DOM: the document is untrusted and is never parsed live
 * outside its sandbox, and the shape the kit asks for — well-formed sections
 * — is what a tag scan with a depth count needs. A document with no marked
 * section comes back unchanged with no phones, which is every design drawn
 * before the mark existed.
 */

export type PhoneSurface = {
  /** The section's `data-testid`, or a positional id when it has none. */
  readonly id: string;
  /** What the screen is called: the id's name, or its first heading. */
  readonly title: string;
  /** A self-contained document holding that one screen. */
  readonly html: string;
};

export type SplitDesign = {
  /** The design with its phone screens removed. */
  readonly main: string;
  readonly phones: readonly PhoneSurface[];
};

/** The screen the window draws around a phone surface, in CSS pixels. */
export const PHONE_VIEWPORT_WIDTH = 402;

const SECTION_TAG = /<(\/?)section\b[^>]*>/gi;
const PHONE_MARK = /\bdata-surface\s*=\s*["']phone["']/i;
const TEST_ID = /\bdata-testid\s*=\s*["']([^"']+)["']/i;
const HEAD = /<head\b[^>]*>([\s\S]*?)<\/head>/i;
const HTML_OPEN = /<html\b([^>]*)>/i;
const BODY_OPEN = /<body\b([^>]*)>/i;
const HEADING = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i;

/* The screen fills its viewport whatever width the section was given for
   the wide page, and nothing but the page scrolls. */
const SCREEN_STYLE =
  "<style>html,body{margin:0;padding:0;min-width:0;width:100%}body{overflow-x:hidden}" +
  'section[data-surface="phone"]{box-sizing:border-box;width:100%!important;min-width:0!important;max-width:none!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important}</style>';

function titleOf(id: string | null, section: string, index: number): string {
  const fromId = id?.replace(/^screen-/, "").replace(/[-_]+/g, " ").trim();
  if (fromId) return fromId.charAt(0).toUpperCase() + fromId.slice(1);
  const heading = HEADING.exec(section)?.[1]?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (heading) return heading;
  return `Screen ${index + 1}`;
}

export function splitPhoneSurfaces(html: string): SplitDesign {
  const open: { start: number; phone: boolean }[] = [];
  const ranges: { start: number; end: number }[] = [];
  for (const match of html.matchAll(SECTION_TAG)) {
    const closing = match[1] === "/";
    if (!closing) {
      open.push({ start: match.index, phone: PHONE_MARK.test(match[0]) });
      continue;
    }
    const opened = open.pop();
    if (!opened) continue;
    // Only an outermost phone section is a phone; one drawn inside another
    // is part of that screen.
    if (opened.phone && !open.some((entry) => entry.phone)) {
      ranges.push({ start: opened.start, end: match.index + match[0].length });
    }
  }
  if (ranges.length === 0) return { main: html, phones: [] };

  const headInner = HEAD.exec(html)?.[1] ?? "";
  const htmlAttrs = HTML_OPEN.exec(html)?.[1] ?? "";
  const bodyAttrs = BODY_OPEN.exec(html)?.[1] ?? "";
  const phones = ranges.map((range, index) => {
    const section = html.slice(range.start, range.end);
    const id = TEST_ID.exec(section.slice(0, section.indexOf(">") + 1))?.[1] ?? null;
    return {
      id: id ?? `phone-${index + 1}`,
      title: titleOf(id, section, index),
      html: `<!doctype html><html${htmlAttrs}><head>${headInner}${SCREEN_STYLE}</head><body${bodyAttrs}>${section}</body></html>`,
    };
  });
  let main = html;
  for (const range of [...ranges].reverse()) {
    main = main.slice(0, range.start) + main.slice(range.end);
  }
  return { main, phones };
}
