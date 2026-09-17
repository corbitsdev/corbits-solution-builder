/**
 * A PowerPoint file a person supplies as a style guide for a stakeholder
 * role's decks. Nothing is copied out of it slide by slide; what is read is
 * its theme — the accent and text colours, the title and body typefaces,
 * and the slide's proportions — and the decks for that role are drawn with
 * those. Kept as a file beside the deck settings, one per role.
 *
 * The theme parse itself (`themeFromXml`/`themeFromPptx`) is pure OOXML
 * reading with no persistence, so it lives in `@solutions-builder/tools-deck`
 * and runs the same way here and in the sidecar; this file is only the
 * host's file storage around it.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { TemplateTheme } from "@solutions-builder/app/deck";
import { templateCanCarryADeck } from "@solutions-builder/app/deck-on-template";
import { themeFromPptx } from "@solutions-builder/tools-deck/deck-theme";
import { HostError } from "./errors.js";
import { dataDirectory } from "./paths.js";

export type { TemplateTheme };
export { themeFromXml, themeFromPptx } from "@solutions-builder/tools-deck/deck-theme";

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
