/**
 * The approved GUI mockup as pictures for a stakeholder's slides (#227).
 *
 * A stage 4 design is an HTML document with one `[data-surface]` element per
 * screen. Every deck carries those screens, whatever the role's images
 * setting says: a "What it looks like" slide is one, the cover shows one,
 * and the rest go to item slides, spread out and never repeated (#252). The
 * renderer already lays out a right-hand picture on the cover and on item
 * slides, and a full-width one on a slide with no lines; this supplies them.
 *
 * `mockupShots` runs in the browser: the design is loaded into a hidden
 * same-origin frame with its scripts removed, each screen is serialised into
 * an SVG `foreignObject` with the document's own styles, and that is drawn
 * to a canvas and read back as PNG. No library, and nothing leaves the
 * window. The SVG travels as a `data:` URL: the host serves the interface
 * with `img-src 'self' data:`, so a `blob:` image never loads (#230).
 * `placeMockups` and `shotSvg` are pure; the first assigns, the second
 * assembles.
 */
import type { Deck } from "@solutions-builder/app/deck";

/** One screen of the mockup: the name a slide may ask for it by, and its picture. */
/** What a screen is: a phone's, or a desktop's (a browser window), for the body it is drawn in (#654). */
export type ScreenKind = "phone" | "desktop";

export type MockupShot = {
  readonly name: string;
  readonly png: Uint8Array;
  readonly kind?: ScreenKind;
  readonly width?: number;
  readonly height?: number;
  /** The picture is already inside its body (#666); framing it again would nest one. */
  readonly framed?: boolean;
};

/**
 * A screen's kind (#654): the design's `data-surface` mark when it has
 * one, else a named test id that says phone or mobile, else its width: a
 * screen narrower than a small tablet is a phone's.
 */
export function screenKind(surface: string | null | undefined, testId: string | null | undefined, width: number): ScreenKind {
  const mark = (surface ?? "").trim().toLowerCase();
  if (/^(phone|mobile|ios|android|handset)$/.test(mark)) return "phone";
  if (/^(desktop|web|browser|tablet|laptop)$/.test(mark)) return "desktop";
  if (/(phone|mobile|ios|android|handset)/i.test(testId ?? "")) return "phone";
  return width <= 520 ? "phone" : "desktop";
}

export type Shooter = (html: string, max: number) => Promise<MockupShot[]>;

/**
 * The names a design's screens go by (#302): the `screen-`/`view-` test
 * ids the designer names each section with, as words, each once, in order;
 * else its `data-surface` values, which are kinds (phone, desktop) rather
 * than names and so only tell screens apart in a design with one of each.
 * What the hand-off lists and a slide may name.
 */
export function screenNamesOf(html: string): string[] {
  const names: string[] = [];
  const add = (raw: string | undefined) => {
    const name = (raw ?? "").trim();
    if (name && !names.includes(name)) names.push(name);
  };
  for (const match of html.matchAll(/data-testid\s*=\s*(?:"((?:screen|view)-[^"]+)"|'((?:screen|view)-[^']+)')/g)) add(screenNameOfTestId(match[1] ?? match[2] ?? ""));
  if (names.length > 0) return names;
  for (const match of html.matchAll(/data-surface\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) add(match[1] ?? match[2]);
  return names;
}

/** `screen-phone-home` → "phone home": the test id a designer named a section with, as words. */
function screenNameOfTestId(testId: string): string {
  return testId.replace(/^(screen|view)-/, "").replace(/[-_]+/g, " ").trim();
}

/** A wide screen is captured as a viewport, not a whole page: this much of its width, from the top (#302). */
const WIDE_SCREEN_MIN_WIDTH = 700;
const WIDE_SCREEN_HEIGHT_RATIO = 0.75;

/** How tall a screen's capture is: its own height, or a viewport of it when it is a long wide page. */
export function captureHeight(width: number, height: number): number {
  return width >= WIDE_SCREEN_MIN_WIDTH ? Math.min(height, Math.round(width * WIDE_SCREEN_HEIGHT_RATIO)) : height;
}

/** How wide a screen is drawn, in CSS pixels, before the device pixel ratio. */
const SHOT_SCALE = 2;
const LOAD_TIMEOUT_MS = 8_000;

/**
 * The deck's pictures with the mockup's screens placed (#252): existing
 * illustrations are kept; a slide that names a screen, `(screen: <name>)`
 * in its outline item (#302), takes that one by name or by number; a
 * slide with no lines — the outline's "What it looks like" — takes a screen
 * next, since the picture is the slide; the cover takes one when it has
 * none; and the screens left are spread evenly over the item slides still
 * without a picture. Each screen is used once, so no two slides in a row
 * carry the same one, and a slide is allowed to have no picture: running
 * out of screens leaves the rest bare rather than cycling. No screens
 * leaves the pictures as they were.
 */
export function placeMockups(deck: Pick<Deck, "slides" | "images">, shots: readonly MockupShot[]): Map<string, Uint8Array> {
  const images = new Map(deck.images ?? []);
  if (shots.length === 0) return images;
  const queue = [...shots];
  const byName = (wanted: string): MockupShot | undefined => {
    const name = wanted.trim().toLowerCase();
    const number = Number(name);
    if (Number.isInteger(number) && number >= 1 && number <= shots.length) return shots[number - 1];
    return shots.find((shot) => shot.name.toLowerCase() === name);
  };
  deck.slides.forEach((slide, index) => {
    const key = String(index);
    if (!slide.screen || images.has(key)) return;
    const shot = byName(slide.screen);
    if (!shot) return;
    images.set(key, shot.png);
    const at = queue.indexOf(shot);
    if (at !== -1) queue.splice(at, 1);
  });
  const take = () => queue.shift()?.png;
  deck.slides.forEach((slide, index) => {
    const key = String(index);
    if (slide.bullets.length === 0 && !images.has(key)) {
      const shot = take();
      if (shot) images.set(key, shot);
    }
  });
  if (!images.has("cover")) {
    const shot = take();
    if (shot) images.set("cover", shot);
  }
  const bare = deck.slides.map((_, index) => String(index)).filter((key) => !images.has(key));
  const count = Math.min(queue.length, bare.length);
  for (let i = 0; i < count; i += 1) {
    // The i-th of `count` pictures lands on the slide at that fraction of the
    // bare ones, so two screens on eight slides sit apart, not both up front.
    const at = count === bare.length ? i : Math.floor(((i + 0.5) * bare.length) / count);
    images.set(bare[at]!, take()!);
  }
  return images;
}

/** The sections the designer names as screens, whatever surface mark they carry or lack. */
const NAMED_SCREEN_SELECTOR = ['[data-testid^="screen-"]', '[data-testid^="view-"]'].map((mark) => `section${mark}, article${mark}`).join(", ");

/**
 * Which elements are the design's screens (#284): the ones marked with a
 * surface; else the sections the designer named as screens or views; else
 * the page's own top-level sections, the design notes left out; and only a
 * design with none of those is shot as its whole page. A nine-view mockup
 * with no marks is nine landscape pictures, never one tall strip.
 */
export function chooseScreens<T>(candidates: { surfaces: readonly T[]; named: readonly T[]; sections: readonly T[]; body: T }): T[] {
  if (candidates.surfaces.length > 0) return [...candidates.surfaces];
  if (candidates.named.length > 0) return [...candidates.named];
  if (candidates.sections.length > 0) return [...candidates.sections];
  return [candidates.body];
}

/** What a captured screen is called: its named test id, else its surface kind, else its first heading, else its place. */
function screenNameOf(target: HTMLElement, index: number): string {
  const testId = target.getAttribute("data-testid") ?? "";
  if (/^(screen|view)-/.test(testId)) return screenNameOfTestId(testId);
  const surface = target.getAttribute("data-surface")?.trim();
  if (surface) return surface;
  const heading = target.querySelector("h1, h2, h3")?.textContent?.trim();
  return heading || `screen ${String(index + 1)}`;
}

/** The screens of an HTML mockup, named and drawn, at most `max`; none outside a browser or for a design with nothing to draw. */
export async function mockupShots(html: string, max = 8): Promise<MockupShot[]> {
  if (typeof document === "undefined" || typeof window === "undefined") return [];
  const frame = document.createElement("iframe");
  // Same-origin so the screens can be read; no scripts, since a generated design is untrusted.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:960px;border:0;visibility:hidden";
  frame.srcdoc = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the design took too long to load")), LOAD_TIMEOUT_MS);
      frame.onload = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const doc = frame.contentDocument;
    if (!doc?.body) return [];
    const targets = chooseScreens({
      surfaces: [...doc.querySelectorAll<HTMLElement>("[data-surface]")],
      named: [...doc.querySelectorAll<HTMLElement>(NAMED_SCREEN_SELECTOR)],
      sections: [...doc.querySelectorAll<HTMLElement>("body > section, body > main > section, body > article, body > main > article")].filter(
        (section) => !/^design-notes$/i.test(section.getAttribute("data-testid") ?? ""),
      ),
      body: doc.body,
    }).slice(0, max);
    const styles = [...doc.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
    const shots: MockupShot[] = [];
    for (const [index, target] of targets.entries()) {
      const rect = target.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      const width = Math.ceil(rect.width);
      shots.push({
        name: screenNameOf(target, index),
        png: await rasterise(target, styles, doc),
        kind: screenKind(target.getAttribute("data-surface"), target.getAttribute("data-testid"), width),
        width,
        height: captureHeight(width, Math.ceil(rect.height)),
      });
    }
    return shots;
  } finally {
    frame.remove();
  }
}

/** Text as XML character data: what goes between tags inside the SVG. */
function xmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** What the wrapper takes from the mockup's body, so the screen sits on its own paper in its own type. */
export type BodyLook = { readonly backgroundColor: string; readonly color: string; readonly font: string };

/**
 * One screen as an SVG document: the element's XHTML serialisation inside a
 * `foreignObject`, under the document's styles. The wrapper's look goes in
 * a style rule, never an attribute: a computed `font` carries quotes
 * (`"Segoe UI"`) that would end the attribute early (#230). Styles are
 * escaped as XML text, and the result is a `data:` URL an `<img>` may load
 * under the host's image policy.
 */
export function shotSvg(markup: string, styles: string, size: { width: number; height: number }, body: BodyLook): string {
  const width = String(Math.ceil(size.width));
  const height = String(Math.ceil(size.height));
  const wrapper = `.sb-shot{width:${width}px;height:${height}px;overflow:hidden;background:${body.backgroundColor};color:${body.color};font:${body.font}}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<foreignObject width="100%" height="100%">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" class="sb-shot">`,
    `<style>${xmlText(`${styles}\n${wrapper}`)}</style>`,
    markup,
    `</div></foreignObject></svg>`,
  ].join("");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** One element, with the document's styles, drawn to PNG through an SVG `foreignObject`. */
async function rasterise(target: HTMLElement, styles: string, doc: Document): Promise<Uint8Array> {
  const rect = target.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = captureHeight(width, Math.ceil(rect.height));
  const computed = doc.defaultView?.getComputedStyle(doc.body);
  const body: BodyLook = {
    backgroundColor: computed?.backgroundColor || "white",
    color: computed?.color || "black",
    font: computed?.font || "15px sans-serif",
  };
  const markup = new XMLSerializer().serializeToString(target);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("a screen could not be drawn"));
    element.src = shotSvg(markup, styles, { width, height }, body);
  });
  const canvas = document.createElement("canvas");
  canvas.width = width * SHOT_SCALE;
  canvas.height = height * SHOT_SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no drawing context");
  context.scale(SHOT_SCALE, SHOT_SCALE);
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("a screen could not be encoded");
  return new Uint8Array(await blob.arrayBuffer());
}
