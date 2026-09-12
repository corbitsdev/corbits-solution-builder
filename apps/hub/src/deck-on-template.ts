/**
 * A stakeholder's deck built on the person's own PowerPoint. The template
 * keeps everything that makes it theirs — masters, layouts, theme, fonts,
 * media — and loses its slides; ours are written in their place using the
 * template's own layouts, so a title lands where the template puts titles
 * and the body where it puts bodies, on the template's own background.
 *
 * Written as the OOXML parts directly: a slide is a short XML document
 * naming its layout and filling two placeholders, and a package is a zip of
 * such parts. No library renders "on top of" a template; this is the one
 * way to get the template itself.
 */
import JSZip from "jszip";
import type { Deck } from "./deck.js";

const EMU_PER_INCH = 914_400;
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_NOTES = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";

type Box = { x: number; y: number; cx: number; cy: number };
type Placeholder = { type: string; idx: string | null; box: Box | null };
type Layout = { path: string; type: string | null; name: string; placeholders: Placeholder[] };

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function placeholdersIn(xml: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const match of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const sp = match[1]!;
    const ph = /<p:ph\b([^>]*)\/?>/.exec(sp);
    if (!ph) continue;
    const type = /\btype="([^"]*)"/.exec(ph[1]!)?.[1] ?? "body";
    const idx = /\bidx="([^"]*)"/.exec(ph[1]!)?.[1] ?? null;
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(sp);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(sp);
    const box = off && ext ? { x: Number(off[1]), y: Number(off[2]), cx: Number(ext[1]), cy: Number(ext[2]) } : null;
    out.push({ type, idx, box });
  }
  return out;
}

async function layoutsIn(zip: JSZip): Promise<Layout[]> {
  const paths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  const layouts: Layout[] = [];
  for (const path of paths) {
    const xml = await zip.file(path)!.async("string");
    layouts.push({
      path,
      type: /<p:sldLayout\b[^>]*\btype="([^"]*)"/.exec(xml)?.[1] ?? null,
      name: /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? "",
      placeholders: placeholdersIn(xml),
    });
  }
  return layouts;
}

const has = (layout: Layout, ...types: string[]) => types.every((type) => layout.placeholders.some((ph) => ph.type === type));

/** The layout a cover is written on: the template's title layout, else whatever has a title. */
function coverLayout(layouts: Layout[]): Layout | null {
  return (
    layouts.find((layout) => layout.type === "title" && has(layout, "ctrTitle")) ??
    layouts.find((layout) => /^title$|title slide|^TITLE$/i.test(layout.name)) ??
    layouts.find((layout) => has(layout, "ctrTitle")) ??
    layouts.find((layout) => has(layout, "title")) ??
    layouts[0] ??
    null
  );
}

/** The layout an item is written on: the template's title-and-body layout, else whatever has both. */
function itemLayout(layouts: Layout[]): Layout | null {
  return (
    layouts.find((layout) => (layout.type === "tx" || layout.type === "obj") && has(layout, "title", "body")) ??
    layouts.find((layout) => /title.?and.?(body|content)|title, content/i.test(layout.name) && has(layout, "title", "body")) ??
    layouts.find((layout) => has(layout, "title", "body") && !has(layout, "ctrTitle")) ??
    layouts.find((layout) => has(layout, "title")) ??
    layouts[0] ??
    null
  );
}

/** A placeholder's box, from the layout or else the master, else a guess from the slide size. */
function boxFor(ph: Placeholder | undefined, master: Placeholder[], fallback: Box): Box {
  if (ph?.box) return ph.box;
  const inherited = ph ? master.find((entry) => entry.type === ph.type && (ph.idx === null || entry.idx === ph.idx))?.box ?? master.find((entry) => entry.type === ph.type)?.box : undefined;
  return inherited ?? fallback;
}

function xfrm(box: Box): string {
  return `<a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.cx)}" cy="${Math.round(box.cy)}"/></a:xfrm>`;
}

function shape(id: number, name: string, ph: Placeholder, box: Box | null, paragraphs: string[], bullets: boolean): string {
  const idx = ph.idx !== null ? ` idx="${ph.idx}"` : "";
  const body = paragraphs
    .map((text) => {
      // A title or subtitle takes no bullet and no hanging indent, whatever
      // the layout's placeholder inherits; a body line takes a bullet.
      const pPr = bullets ? '<a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr>' : '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>';
      return `<a:p>${pPr}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
    })
    .join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${ph.type}"${idx}/></p:nvPr></p:nvSpPr><p:spPr>${box ? xfrm(box) : ""}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body || "<a:p/>"}</p:txBody></p:sp>`;
}

function picture(id: number, rId: string, box: Box, ratio: number): string {
  // Contained in the box, keeping the picture's proportions, centred.
  let cx = box.cx;
  let cy = cx / ratio;
  if (cy > box.cy) {
    cy = box.cy;
    cx = cy * ratio;
  }
  const x = box.x + (box.cx - cx) / 2;
  const y = box.y + (box.cy - cy) / 2;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Illustration"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm({ x, y, cx, cy })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function slideXml(shapes: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesXml(text: string): string {
  const paragraphs = text
    .split(/\n+/)
    .map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function rels(entries: { id: string; type: string; target: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map((entry) => `<Relationship Id="${entry.id}" Type="${REL}/${entry.type}" Target="${entry.target}"/>`)
    .join("")}</Relationships>`;
}

/** Whether a PowerPoint file can carry a deck: it has a presentation part and at least one layout. */
export async function templateCanCarryADeck(bytes: Uint8Array): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    return zip.file("ppt/presentation.xml") !== null && (await layoutsIn(zip)).length > 0;
  } catch {
    return false;
  }
}

/** The deck written into the template: its slides gone, ours in their place on its layouts. */
export async function renderDeckOnTemplate(template: Uint8Array, deck: Deck): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(template);
  const presentationPath = "ppt/presentation.xml";
  let presentation = await zip.file(presentationPath)?.async("string");
  if (!presentation) throw new Error("The template has no presentation part.");
  const size = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation) ?? /<p:sldSz\b[^>]*\bcy="(\d+)"[^>]*\bcx="(\d+)"/.exec(presentation);
  const cxAttrFirst = presentation.indexOf('cx="') < presentation.indexOf('cy="');
  const W = size ? Number(cxAttrFirst ? size[1] : size[2]) : 10 * EMU_PER_INCH;
  const H = size ? Number(cxAttrFirst ? size[2] : size[1]) : 5.625 * EMU_PER_INCH;

  const layouts = await layoutsIn(zip);
  const cover = coverLayout(layouts);
  const item = itemLayout(layouts);
  if (!cover || !item) throw new Error("The template has no layout to write a slide on.");
  const masterPath = Object.keys(zip.files).find((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
  const master = masterPath ? placeholdersIn(await zip.file(masterPath)!.async("string")) : [];
  const notesMaster = Object.keys(zip.files).find((name) => /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(name)) ?? null;

  // The template's own slides, their notes and comments go; everything else stays.
  const removed = Object.keys(zip.files).filter((name) => /^ppt\/(slides|notesSlides|comments)\//.test(name));
  for (const name of removed) zip.remove(name);
  const presRelsPath = "ppt/_rels/presentation.xml.rels";
  let presRels = (await zip.file(presRelsPath)?.async("string")) ?? rels([]);
  presRels = presRels.replace(/<Relationship\b[^>]*Target="(slides|comments|notesSlides)\/[^"]*"[^>]*\/>/g, "");
  const usedIds = [...presRels.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
  let nextRel = Math.max(0, ...usedIds) + 1;
  let contentTypes = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";
  contentTypes = contentTypes.replace(/<Override\b[^>]*PartName="\/ppt\/(slides|notesSlides|comments)\/[^"]*"[^>]*\/>/g, "");
  if (deck.images && deck.images.size > 0 && !/Extension="png"/i.test(contentTypes)) {
    contentTypes = contentTypes.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');
  }

  const sldIds: string[] = [];
  const overrides: string[] = [];
  let slideNumber = 0;
  let imageNumber = 0;
  const bodyFallback: Box = { x: W * 0.08, y: H * 0.28, cx: W * 0.84, cy: H * 0.6 };
  const titleFallback: Box = { x: W * 0.08, y: H * 0.08, cx: W * 0.84, cy: H * 0.16 };

  const writeSlide = (layout: Layout, shapes: string[], images: { rId: string; bytes: Uint8Array }[], notes: string | null) => {
    slideNumber += 1;
    const path = `ppt/slides/slide${slideNumber}.xml`;
    zip.file(path, slideXml(shapes));
    const slideRels = [{ id: "rId1", type: "slideLayout", target: `../${layout.path.slice("ppt/".length)}` }];
    for (const image of images) {
      imageNumber += 1;
      const media = `ppt/media/deck-image-${imageNumber}.png`;
      zip.file(media, image.bytes);
      slideRels.push({ id: image.rId, type: "image", target: `../media/deck-image-${imageNumber}.png` });
    }
    if (notes && notesMaster) {
      const notesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
      zip.file(notesPath, notesXml(notes));
      zip.file(
        `ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`,
        rels([
          { id: "rId1", type: "notesMaster", target: `../${notesMaster.slice("ppt/".length)}` },
          { id: "rId2", type: "slide", target: `../slides/slide${slideNumber}.xml` },
        ]),
      );
      slideRels.push({ id: "rIdNotes", type: "notesSlide", target: `../notesSlides/notesSlide${slideNumber}.xml` });
      overrides.push(`<Override PartName="/${notesPath}" ContentType="${CT_NOTES}"/>`);
    }
    zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, rels(slideRels));
    overrides.push(`<Override PartName="/${path}" ContentType="${CT_SLIDE}"/>`);
    const rId = `rId${nextRel}`;
    nextRel += 1;
    presRels = presRels.replace("</Relationships>", `<Relationship Id="${rId}" Type="${REL}/slide" Target="slides/slide${slideNumber}.xml"/></Relationships>`);
    sldIds.push(`<p:sldId id="${255 + slideNumber}" r:id="${rId}"/>`);
  };

  // The cover, on the title layout.
  {
    const titlePh = cover.placeholders.find((ph) => ph.type === "ctrTitle") ?? cover.placeholders.find((ph) => ph.type === "title");
    const subPh = cover.placeholders.find((ph) => ph.type === "subTitle") ?? cover.placeholders.find((ph) => ph.type === "body");
    const shapes: string[] = [];
    const images: { rId: string; bytes: Uint8Array }[] = [];
    const coverImage = deck.images?.get("cover");
    // The picture goes where the layout's title is not: a title that sits
    // left leaves the right free, one that sits right leaves the left, and
    // one across the middle gives up its right part.
    const titleBox = titlePh ? boxFor(titlePh, master, titleFallback) : titleFallback;
    const side = !coverImage ? null : titleBox.x + titleBox.cx <= W * 0.56 ? "right" : titleBox.x >= W * 0.44 ? "left" : "squeeze";
    const narrowed = (box: Box): Box | null => (side === "squeeze" ? { ...box, cx: box.cx * 0.58 } : null);
    if (titlePh) shapes.push(shape(2, "Title", titlePh, narrowed(titleBox), [deck.projectTitle], false));
    if (subPh) {
      shapes.push(
        shape(3, "Subtitle", subPh, narrowed(boxFor(subPh, master, bodyFallback)), [`Prepared for ${deck.audience} · ${deck.role}`, "Is this worth pursuing? Rough figures throughout; a firm estimate follows at stage 7."], false),
      );
    }
    if (coverImage && side) {
      const box: Box =
        side === "left"
          ? { x: W * 0.06, y: H * 0.12, cx: W * 0.34, cy: H * 0.76 }
          : side === "right"
            ? { x: W * 0.6, y: H * 0.12, cx: W * 0.34, cy: H * 0.76 }
            : // Squeezed: the picture takes the part of the title's own box the title gave up.
              { x: titleBox.x + titleBox.cx * 0.62, y: H * 0.12, cx: Math.min(titleBox.cx * 0.38, W - titleBox.x - titleBox.cx * 0.62 - W * 0.04), cy: H * 0.76 };
      shapes.push(picture(4, "rIdImg", box, 1.5));
      images.push({ rId: "rIdImg", bytes: coverImage });
    }
    writeSlide(cover, shapes, images, null);
  }

  // One slide per outline item, and the decision request, on the title-and-body layout.
  const titlePh = item.placeholders.find((ph) => ph.type === "title") ?? item.placeholders.find((ph) => ph.type === "ctrTitle");
  const bodyPh = item.placeholders.find((ph) => ph.type === "body") ?? item.placeholders.find((ph) => ph.type === "subTitle");
  const writeItem = (title: string, lines: readonly string[], notes: string | null, image: Uint8Array | undefined) => {
    const shapes: string[] = [];
    const images: { rId: string; bytes: Uint8Array }[] = [];
    if (titlePh) shapes.push(shape(2, "Title", titlePh, null, [title], false));
    if (bodyPh) {
      const full = boxFor(bodyPh, master, bodyFallback);
      const box = image ? { ...full, cx: full.cx * 0.58 } : null;
      shapes.push(shape(3, "Body", bodyPh, box, [...lines], true));
      if (image) {
        shapes.push(picture(4, "rIdImg", { x: full.x + full.cx * 0.62, y: full.y, cx: full.cx * 0.38, cy: full.cy }, 1.5));
        images.push({ rId: "rIdImg", bytes: image });
      }
    }
    writeSlide(item, shapes, images, deck.design.notes ? notes : null);
  };
  deck.slides.forEach((entry, index) => writeItem(entry.title, entry.bullets, entry.notes, deck.images?.get(String(index))));
  if (deck.decision.length > 0) writeItem("Decision request", deck.decision, null, undefined);

  // The presentation lists the new slides; the package knows their types.
  const list = `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>`;
  presentation = /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/.test(presentation)
    ? presentation.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, list)
    : /<p:sldIdLst\/>/.test(presentation)
      ? presentation.replace(/<p:sldIdLst\/>/, list)
      : presentation.replace(/(<\/p:sldMasterIdLst>|<\/p:notesMasterIdLst>)/, `$1${list}`);
  zip.file(presentationPath, presentation);
  zip.file(presRelsPath, presRels);
  zip.file("[Content_Types].xml", contentTypes.replace("</Types>", `${overrides.join("")}</Types>`));

  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
