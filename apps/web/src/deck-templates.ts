/**
 * A stakeholder role's PowerPoint style guide: reading a `.pptx`'s theme in
 * the browser, and the pure shape of which role points at which uploaded
 * template.
 *
 * Nothing here talks to the host. `client.ts` uploads the file, keeps one
 * artifact per template and one text artifact holding the role→template
 * map; these helpers read a template's bytes and read/write that map.
 */
import JSZip from "jszip";
import type { TemplateTheme } from "@solutions-builder/app/deck";

/** The kind an uploaded style-guide `.pptx` is stamped with. */
export const DECK_TEMPLATE_KIND = "deck_template";
/** The kind the one workspace-scoped role→template map is stamped with. */
export const DECK_SETTINGS_KIND = "deck_settings";
export const DECK_SETTINGS_TITLE = "Stakeholder deck templates";

export type DeckSettings = {
  readonly roles: Readonly<Record<string, string>>;
};

const EMPTY_SETTINGS: DeckSettings = { roles: {} };

/** `sb.kind: "deck_settings"` content, tolerant of anything else on disk. */
export function parseDeckSettings(content: string | null | undefined): DeckSettings {
  if (!content) return EMPTY_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY_SETTINGS;
  }
  const roles = (parsed as { roles?: unknown } | null)?.roles;
  if (!roles || typeof roles !== "object") return EMPTY_SETTINGS;
  const clean: Record<string, string> = {};
  for (const [role, templateArtifactId] of Object.entries(roles as Record<string, unknown>)) {
    if (typeof templateArtifactId === "string" && templateArtifactId.length > 0) clean[role] = templateArtifactId;
  }
  return { roles: clean };
}

/** `settings` with `role` mapped to `templateArtifactId`, or unmapped when null. Pure. */
export function withRoleTemplate(settings: DeckSettings, role: string, templateArtifactId: string | null): DeckSettings {
  const roles = { ...settings.roles };
  if (templateArtifactId) {
    roles[role] = templateArtifactId;
  } else {
    delete roles[role];
  }
  return { roles };
}

/** `DeckSettings` as the text an artifact's content is written as. */
export function deckSettingsContent(settings: DeckSettings): string {
  return JSON.stringify(settings);
}

/**
 * Where a stakeholder's slides come from: a mapped style guide always wins,
 * even over an already-recorded deck, because that deck was drawn before the
 * mapping existed (or with a different one). Without a mapped theme, a
 * recorded deck is kept as is; otherwise the default look is built fresh.
 */
export function slidesSource(args: { hasRecordedDeck: boolean; theme: TemplateTheme | null }): "recorded" | "build" {
  if (args.theme) return "build";
  return args.hasRecordedDeck ? "recorded" : "build";
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

/**
 * The theme a PowerPoint file carries: its first theme part and its slide
 * size. A `.pptx` is a zip of XML, so this runs entirely in the browser.
 */
export async function readTemplateTheme(bytes: Uint8Array): Promise<TemplateTheme> {
  const zip = await JSZip.loadAsync(bytes);
  const themePart = Object.keys(zip.files).find((name) => /^ppt\/theme\/theme\d*\.xml$/.test(name));
  const theme = themePart ? themeFromXml(await zip.file(themePart)!.async("string")) : {};
  const presentation = zip.file("ppt/presentation.xml");
  const size = presentation ? /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(await presentation.async("string")) : null;
  const ratio = size ? Number(size[1]) / Number(size[2]) : undefined;
  return { ...theme, ...(ratio && Number.isFinite(ratio) ? { ratio: Math.round(ratio * 100) / 100 } : {}) };
}
