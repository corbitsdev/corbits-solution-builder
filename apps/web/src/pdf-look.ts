/**
 * What a PDF of an existing deck says about how slides should look (#254):
 * the slide ratio from its first page's size, and the paper, ink and accent
 * colours from its first pages, rendered small and counted. Typefaces
 * cannot be read from a picture and are not guessed at.
 *
 * `pdfLook` runs in the browser: the pages are drawn with the same PDF
 * library that reads a PDF's text, onto a canvas that never joins the page.
 * `lookFromPixels` is pure, so the classification is testable without one.
 */
import type { TemplateTheme } from "@solutions-builder/app/deck";

/** How wide a page is drawn for counting, in pixels; enough for a colour, cheap for a PDF of many pages. */
const SAMPLE_WIDTH = 96;
/** How many pages are counted: a cover can be a photograph; three pages find the house colours. */
const SAMPLE_PAGES = 3;
/** Each channel is counted in this many steps, so anti-aliasing does not scatter one colour into hundreds. */
const LEVELS = 16;
/** A colour has to cover this share of the counted pixels to be the accent. */
const ACCENT_COVERAGE = 0.005;

type Rgb = readonly [number, number, number];

function lightness([r, g, b]: Rgb): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
}

function saturation([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 510;
  return (max - min) / 255 / (1 - Math.abs(2 * l - 1));
}

function hex([r, g, b]: Rgb): string {
  return [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Pixels (RGBA runs, as a canvas hands them back) counted into a coarse
 * histogram: the most common light colour is the paper, the most common
 * dark colour the ink, and the most common colour that is neither, with
 * real saturation and coverage, the accent. Anything not found is left
 * unset, so the role's own choice stands for it; no colour at all yields
 * null so a blank render is not a theme.
 */
export function lookFromPixels(pages: readonly Uint8ClampedArray[], ratio: number | null): TemplateTheme | null {
  const counts = new Map<number, number>();
  let total = 0;
  const step = 256 / LEVELS;
  for (const pixels of pages) {
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      if (pixels[i + 3]! < 128) continue;
      const key = Math.floor(pixels[i]! / step) * LEVELS * LEVELS + Math.floor(pixels[i + 1]! / step) * LEVELS + Math.floor(pixels[i + 2]! / step);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  const theme: { -readonly [K in keyof TemplateTheme]: TemplateTheme[K] } = {};
  if (ratio !== null && Number.isFinite(ratio) && ratio > 0) theme.ratio = Math.round(ratio * 100) / 100;
  if (total > 0) {
    const centre = (key: number): Rgb => {
      const half = step / 2;
      return [Math.min(255, Math.round(Math.floor(key / (LEVELS * LEVELS)) * step + half)), Math.min(255, Math.round((Math.floor(key / LEVELS) % LEVELS) * step + half)), Math.min(255, Math.round((key % LEVELS) * step + half))];
    };
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ rgb: centre(key), share: count / total }));
    const paper = ranked.find((entry) => lightness(entry.rgb) > 0.85);
    const ink = ranked.find((entry) => lightness(entry.rgb) < 0.35 && saturation(entry.rgb) < 0.6);
    const accent = ranked.find((entry) => {
      const l = lightness(entry.rgb);
      return entry.share >= ACCENT_COVERAGE && saturation(entry.rgb) >= 0.35 && l >= 0.2 && l <= 0.75;
    });
    if (paper) theme.paper = hex(paper.rgb);
    if (ink) theme.ink = hex(ink.rgb);
    if (accent) theme.accent = hex(accent.rgb);
  }
  return Object.keys(theme).length > 0 ? theme : null;
}

/**
 * The look of a PDF's first pages, or null outside a browser or when the
 * file cannot be drawn. Never throws for a file that opens: a page that
 * fails to render is skipped, and what the others say still counts.
 */
export async function pdfLook(bytes: Uint8Array): Promise<TemplateTheme | null> {
  if (typeof document === "undefined") return null;
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const pages: Uint8ClampedArray[] = [];
  let ratio: number | null = null;
  const count = Math.min(pdf.numPages, SAMPLE_PAGES);
  for (let number = 1; number <= count; number += 1) {
    try {
      const page = await pdf.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      if (number === 1 && natural.width > 0 && natural.height > 0) ratio = natural.width / natural.height;
      const viewport = page.getViewport({ scale: SAMPLE_WIDTH / natural.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) continue;
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      pages.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
    } catch {
      // A page that will not draw says nothing; the others still count.
    }
  }
  return lookFromPixels(pages, ratio);
}
