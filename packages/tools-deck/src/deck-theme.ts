/**
 * The theme a PowerPoint style guide carries: its accent and text colours,
 * its title and body typefaces, and its slide proportions. Pure OOXML
 * parsing — no file I/O, no persistence — so it renders in the sidecar the
 * same way it renders in the hub, which only stores the bytes and calls in
 * here for what they mean.
 */
import JSZip from "jszip";
import type { TemplateTheme } from "@solutions-builder/app/deck";

export type { TemplateTheme };

/** The theme a PowerPoint file carries: its first theme part and its slide size. */
export async function themeFromPptx(bytes: Uint8Array): Promise<TemplateTheme> {
  const zip = await JSZip.loadAsync(bytes);
  const themePart = Object.keys(zip.files).find((name) => /^ppt\/theme\/theme\d*\.xml$/.test(name));
  const theme = themePart ? themeFromXml(await zip.file(themePart)!.async("string")) : {};
  const presentation = zip.file("ppt/presentation.xml");
  const size = presentation ? /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(await presentation.async("string")) : null;
  const ratio = size ? Number(size[1]) / Number(size[2]) : undefined;
  return { ...theme, ...(ratio && Number.isFinite(ratio) ? { ratio: Math.round(ratio * 100) / 100 } : {}) };
}

/** A colour from a theme element: an sRGB value, or a system colour's last-rendered value. */
function colourIn(xml: string, element: string): string | undefined {
  const block = new RegExp(`<a:${element}>([\\s\\S]*?)</a:${element}>`).exec(xml)?.[1];
  if (!block) return undefined;
  const srgb = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
  const system = /<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
  return (srgb ?? system)?.toUpperCase();
}

function faceIn(xml: string, element: string): string | undefined {
  const block = new RegExp(`<a:${element}>([\\s\\S]*?)</a:${element}>`).exec(xml)?.[1];
  const face = block ? /<a:latin typeface="([^"]*)"/.exec(block)?.[1] : undefined;
  return face && face.trim() && !face.startsWith("+") ? face.trim() : undefined;
}

/** The parts of a theme XML a deck is drawn with. Exported so the parse can be checked without a file. */
export function themeFromXml(xml: string): TemplateTheme {
  const theme: { -readonly [K in keyof TemplateTheme]: TemplateTheme[K] } = {};
  const accent = colourIn(xml, "accent1");
  const ink = colourIn(xml, "dk1");
  const paper = colourIn(xml, "lt1");
  const titleFace = faceIn(xml, "majorFont");
  const bodyFace = faceIn(xml, "minorFont");
  if (accent) theme.accent = accent;
  if (ink) theme.ink = ink;
  if (paper) theme.paper = paper;
  if (titleFace) theme.titleFace = titleFace;
  if (bodyFace) theme.bodyFace = bodyFace;
  return theme;
}
