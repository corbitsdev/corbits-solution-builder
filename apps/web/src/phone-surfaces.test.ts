import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitPhoneSurfaces } from "./phone-surfaces.ts";
import { framedDesign } from "./design-frames.tsx";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

const design = [
  "<!doctype html>",
  '<html lang="en"><head><title>Workout Log</title><style>body{font:16px sans-serif}.screen{width:402px}</style></head>',
  '<body class="light">',
  '<section data-testid="screen-capture" data-surface="phone" class="screen"><h1>Capture</h1><section data-testid="inner"><p>Nested</p></section></section>',
  '<section data-testid="screen-admin"><h1>Admin console</h1></section>',
  '<section data-surface="phone"><h2>Review queue</h2></section>',
  '<section data-testid="design-notes"><h2>Primary flows</h2></section>',
  "</body></html>",
].join("\n");

// #101: the phone screens the designer marks come out one by one, each a
// document of its own that shares the design's head, and the rest stays.
describe("splitting phone screens out of a design", () => {
  test("a design with no marked screen is left whole", () => {
    const html = "<!doctype html><html><body><section data-testid=\"screen-web\"><h1>Web</h1></section></body></html>";
    expect(splitPhoneSurfaces(html)).toEqual({ main: html, phones: [] });
  });

  test("each outermost marked section is a phone, named by its id or its heading", () => {
    const { phones } = splitPhoneSurfaces(design);
    expect(phones.map((phone) => [phone.id, phone.title])).toEqual([
      ["screen-capture", "Capture"],
      ["phone-2", "Review queue"],
    ]);
  });

  test("a phone's document carries the design's head and body attributes, and the screen fills its width", () => {
    const [capture] = splitPhoneSurfaces(design).phones;
    expect(capture!.html).toStartWith('<!doctype html><html lang="en"><head><title>Workout Log</title><style>body{font:16px sans-serif}.screen{width:402px}</style>');
    expect(capture!.html).toContain('section[data-surface="phone"]{box-sizing:border-box;width:100%!important');
    expect(capture!.html).toContain('<body class="light"><section data-testid="screen-capture" data-surface="phone" class="screen"><h1>Capture</h1><section data-testid="inner"><p>Nested</p></section></section></body></html>');
  });

  test("the rest of the design keeps every other surface and the notes", () => {
    const { main } = splitPhoneSurfaces(design);
    expect(main).toContain('<section data-testid="screen-admin"><h1>Admin console</h1></section>');
    expect(main).toContain('<section data-testid="design-notes">');
    expect(main).not.toContain("Capture");
    expect(main).not.toContain("Review queue");
  });
});

describe("how the review pane frames a design", () => {
  test("as designed: marked screens go in phones and the rest in the pane; an unmarked design is the pane alone", () => {
    const framed = framedDesign(design, "auto", "Workout Log");
    expect(framed.phones).toHaveLength(2);
    expect(framed.main).toContain("screen-admin");
    const plain = "<!doctype html><html><body><p>hi</p></body></html>";
    expect(framedDesign(plain, "auto", "Plain")).toEqual({ phones: [], main: plain });
  });

  test("iPhone: an unmarked design goes into one phone whole, and the pane is empty", () => {
    const plain = "<!doctype html><html><body><p>hi</p></body></html>";
    expect(framedDesign(plain, "phone", "Plain")).toEqual({ phones: [{ id: "whole", title: "Plain", html: plain }], main: null });
  });

  test("pane: marks are ignored and the whole design is the pane", () => {
    expect(framedDesign(design, "pane", "Workout Log")).toEqual({ phones: [], main: design });
  });

  test("the page draws one iPhone per phone, listens for anchors in every frame, and offers the frame choice", () => {
    const frames = read("./design-frames.tsx");
    expect(frames).toContain('<div className="phone-rack" aria-label="Phone screens">');
    expect(frames).toContain("<IPhoneFrame key={`${frameKey}:${phone.id}`} title={phone.title}>");
    expect(frames).toContain('ref={(element) => registerFrame?.("main", element)}');
    expect(frames).toContain('<select aria-label="Frame"');
    const page = read("./pages/design.tsx");
    expect(page).toContain("[...frames.current.values()].map((element) => {");
    expect(page).toContain("<FrameSelect value={frameMode} onChange={setFrameMode} />");
    expect(page).toContain("registerFrame={registerFrame}");
    const reader = read("./pages/workspace/index.tsx");
    expect(reader).toContain("<FrameSelect value={frameMode} onChange={setFrameMode} />");
    expect(reader).toContain('paneClassName="artifact-page"');
    const frame = read("./iphone-frame.tsx");
    expect(frame).toContain('<span className="iphone-island" />');
    expect(frame).toContain('<span className="iphone-home" aria-hidden="true" />');
    const css = read("./styles.css");
    expect(css).toMatch(/\.iphone \{[^}]*--iphone-w: 402px;[^}]*--iphone-h: 874px;/s);
  });
});
