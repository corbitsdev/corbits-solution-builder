/**
 * The approved GUI mockup as pictures for a stakeholder's slides (#227).
 *
 * A stage 4 design is an HTML document with one `[data-surface]` element per
 * screen. Every deck carries those screens as decorative filler, whatever
 * the role's images setting says: the cover shows one, and item slides with
 * no illustration take the others in turn. The renderer already lays out a
 * right-hand picture on the cover and on item slides; this supplies them.
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

export type Shooter = (html: string, max: number) => Promise<Uint8Array[]>;

/** How wide a screen is drawn, in CSS pixels, before the device pixel ratio. */
const SHOT_SCALE = 2;
const LOAD_TIMEOUT_MS = 8_000;

/**
 * The deck's pictures with the mockup's screens filled in: existing
 * illustrations are kept, the cover takes the first screen when it has
 * none, and each item slide without a picture takes the next, cycling
 * through the screens when there are more slides than screens. No screens
 * leaves the pictures as they were.
 */
export function placeMockups(deck: Pick<Deck, "slides" | "images">, shots: readonly Uint8Array[]): Map<string, Uint8Array> {
  const images = new Map(deck.images ?? []);
  if (shots.length === 0) return images;
  let next = 0;
  const take = () => shots[next++ % shots.length]!;
  if (!images.has("cover")) images.set("cover", take());
  deck.slides.forEach((_, index) => {
    const key = String(index);
    if (!images.has(key)) images.set(key, take());
  });
  return images;
}

/** The screens of an HTML mockup as PNG bytes, at most `max`; none outside a browser or for a design with nothing to draw. */
export async function mockupShots(html: string, max = 8): Promise<Uint8Array[]> {
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
    const surfaces = [...doc.querySelectorAll<HTMLElement>("[data-surface]")];
    const targets = (surfaces.length > 0 ? surfaces : [doc.body]).slice(0, max);
    const styles = [...doc.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
    const shots: Uint8Array[] = [];
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      shots.push(await rasterise(target, styles, doc));
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
  const height = Math.ceil(rect.height);
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
