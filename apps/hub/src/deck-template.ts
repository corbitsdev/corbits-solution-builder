/**
 * A PowerPoint file a person supplies as a style guide for a stakeholder
 * role's decks. Nothing is copied out of it slide by slide; what is read is
 * its theme — the accent and text colours, the title and body typefaces,
 * and the slide's proportions — and the decks for that role are drawn with
 * those. Kept as a file beside the deck settings, one per role.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { templateCanCarryADeck } from "@solutions-builder/app/deck-on-template";
import { HostError } from "./errors.js";
import { dataDirectory } from "./paths.js";

/** What a template contributes to a deck's look. Every field optional: a theme names what it names. */
export type TemplateTheme = {
  readonly accent?: string;
  readonly ink?: string;
  readonly paper?: string;
  readonly titleFace?: string;
  readonly bodyFace?: string;
  /** Width over height; 16:9 is 1.78, 4:3 is 1.33. */
  readonly ratio?: number;
};

const TEMPLATE_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
]);
const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024;

function templateDirectory(): string {
  return join(dataDirectory(), "deck-templates");
}

export function templatePath(role: string): string {
  return join(templateDirectory(), `${role}.pptx`);
}

/** Keeps the file as the role's style guide, after checking it is a PowerPoint with a theme. */
export async function storeTemplate(role: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<TemplateTheme> {
  const looksLikeDeck = TEMPLATE_MEDIA_TYPES.has(file.type) || /\.(pptx|potx)$/i.test(file.name);
  if (!looksLikeDeck) throw new HostError("validation_failed", "A style guide is a PowerPoint file (.pptx or .potx).");
  if (file.bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new HostError("validation_failed", "A style guide is at most 25 MB.");
  }
  if (!(await templateCanCarryADeck(file.bytes))) {
    throw new HostError("validation_failed", "That file is not a PowerPoint a deck can be built on: it has no slide layouts.");
  }
  const theme = await themeFromPptx(file.bytes);
  await mkdir(templateDirectory(), { recursive: true });
  await writeFile(templatePath(role), file.bytes);
  return theme;
}

export async function removeTemplate(role: string): Promise<void> {
  await rm(templatePath(role), { force: true });
}

/** The role's style guide as a file, with a fingerprint of it, or null when none is kept. */
export async function templateFor(role: string): Promise<{ bytes: Uint8Array; hash: string } | null> {
  try {
    const bytes = new Uint8Array(await readFile(templatePath(role)));
    return { bytes, hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
  } catch {
    return null;
  }
}

/** The role's style guide theme, or null when none is kept or it cannot be read. */
export async function templateThemeFor(role: string): Promise<TemplateTheme | null> {
  try {
    return await themeFromPptx(new Uint8Array(await readFile(templatePath(role))));
  } catch {
    return null;
  }
}

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
