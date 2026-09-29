/**
 * Deck design documents: what a person hands over about how their decks
 * should look and read — design guidelines as text or Markdown, or an
 * existing presentation as PowerPoint or PDF — and how the set that applies
 * to one project is resolved from the workspace's and the project's own.
 *
 * Pure. `client.ts` lists, adds and removes the artifacts; this module
 * reads their metadata into `DeckDesignDocument`s, says which apply to a
 * project, picks the theme the slides are drawn with, and writes the
 * guidelines block the presentation creator is handed with each request.
 *
 * What is read from each kind of file is said plainly, here and in the
 * interface: text as it is; a PDF's text plus its page size and colours; a
 * PowerPoint's slide text and its theme — colours, typefaces, slide size.
 * The look is the only way a document changes how the slides are drawn.
 */
import type { TemplateTheme } from "@solutions-builder/app/deck";
import { DECK_DESIGN_DOCUMENT_KIND, DECK_DESIGN_READING_KIND } from "@solutions-builder/app/artifacts";

export type DesignDocumentScope = "workspace" | "project";
export type DesignDocumentFormat = "text" | "pdf" | "pptx";

export type DeckDesignDocument = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly format: DesignDocumentFormat;
  readonly scope: DesignDocumentScope;
  /** The look read when the file was added — a PowerPoint's theme, or a PDF's page ratio and colours (#254); null for text. */
  readonly theme: TemplateTheme | null;
  /** Whether any text was read from it; false for a picture-only PDF or PowerPoint, whose look may still have been. */
  readonly textRead: boolean;
  /** The artifact whose content is this document's text: the document itself for text, its reading companion for a binary; null when nothing was read. */
  readonly readingId: string | null;
  readonly createdAt: string;
};

/** Whether the workspace's design documents apply to a project beside its own. Mirrors the installer's `ProjectDeckSettings`. */
export type ProjectDeckSettings = { readonly useWorkspaceDesignDocuments: boolean };

/** What one stakeholder's deck is drafted and drawn against in one project. */
export type DeckBrief = {
  /** The theme the slides are drawn with, or null for the built-in look. */
  readonly theme: TemplateTheme | null;
  /** The block the presentation creator is handed with the request, or null when there is nothing to say. */
  readonly guidelines: string | null;
  /** The documents that applied, by name, for the interface to say so. */
  readonly documents: readonly string[];
};

/** The file picker's filter: the kinds a design document can be. */
export const DESIGN_DOCUMENT_ACCEPT = ".txt,.md,.markdown,.pdf,.pptx";

const PDF_MIME = "application/pdf";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** What kind of design document a file is, or null when it is not one this reads. */
export function designDocumentFormat(name: string, mediaType: string): DesignDocumentFormat | null {
  const lower = name.toLowerCase();
  if (mediaType === PPTX_MIME || lower.endsWith(".pptx")) return "pptx";
  if (mediaType === PDF_MIME || lower.endsWith(".pdf")) return "pdf";
  if (mediaType.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".markdown")) return "text";
  return null;
}

/** Why a file cannot be a design document, or null when it can. */
export function designDocumentRefusal(name: string, mediaType: string): string | null {
  return designDocumentFormat(name, mediaType)
    ? null
    : `${name} is not read as a design document: only text, Markdown, PDF and PowerPoint files are.`;
}

/** What is read from a document of this kind, as the interface says it. */
export function whatIsRead(format: DesignDocumentFormat): string {
  switch (format) {
    case "text":
      return "Read as written and handed to the presentation creator.";
    case "pdf":
      return "Its text is handed to the presentation creator, and its page size and colours draw the slides. Typefaces cannot be read from a PDF.";
    case "pptx":
      return "Its slides' text is handed to the presentation creator, and its theme — colours, typefaces and slide size — draws the slides.";
  }
}

/** A saved theme as `TemplateTheme`, every field checked; null when nothing usable was saved. */
export function themeFrom(value: unknown): TemplateTheme | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const theme: { -readonly [K in keyof TemplateTheme]: TemplateTheme[K] } = {};
  for (const key of ["accent", "ink", "paper", "titleFace", "bodyFace"] as const) {
    if (typeof raw[key] === "string" && raw[key].length > 0) theme[key] = raw[key];
  }
  if (typeof raw.ratio === "number" && Number.isFinite(raw.ratio) && raw.ratio > 0) theme.ratio = raw.ratio;
  return Object.keys(theme).length > 0 ? theme : null;
}

/** The slice of an artifact listing this module reads. */
export type DesignArtifactEntry = {
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown> | null;
};

function sbOf(entry: DesignArtifactEntry): Record<string, unknown> | null {
  const sb = (entry.metadata as { sb?: unknown } | null)?.sb;
  return typeof sb === "object" && sb !== null ? (sb as Record<string, unknown>) : null;
}

/**
 * The design documents among one tenant's artifacts, newest first: every
 * live `deck_design_document`, each paired with its reading companion when
 * one was written. A text document is its own reading.
 */
export function designDocumentsFrom(entries: readonly DesignArtifactEntry[], scope: DesignDocumentScope): DeckDesignDocument[] {
  const live = entries.map((entry) => ({ entry, sb: sbOf(entry) })).filter((row) => row.entry.archivedAt === null && row.sb !== null);
  const readings = new Map<string, string>();
  for (const { entry, sb } of live) {
    if (sb!.kind !== DECK_DESIGN_READING_KIND) continue;
    const sources = Array.isArray(sb!.sourceVersionIds) ? sb!.sourceVersionIds : [];
    for (const source of sources) if (typeof source === "string") readings.set(source, entry.id);
  }
  return live
    .filter(({ sb }) => sb!.kind === DECK_DESIGN_DOCUMENT_KIND)
    .map(({ entry, sb }) => {
      const name = typeof sb!.variant === "string" && sb!.variant.length > 0 ? sb!.variant : entry.title;
      const mediaType = typeof sb!.mediaType === "string" ? sb!.mediaType : "application/octet-stream";
      const format = designDocumentFormat(name, mediaType) ?? "text";
      return {
        id: entry.id,
        name,
        mediaType,
        format,
        scope,
        theme: format === "text" ? null : themeFrom(sb!.theme),
        textRead: sb!.textRead !== false,
        readingId: format === "text" ? entry.id : (readings.get(entry.id) ?? null),
        createdAt: entry.createdAt,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The reading companions of `documentId` among one tenant's artifacts: what a remove archives beside the file. */
export function readingIdsFor(entries: readonly DesignArtifactEntry[], documentId: string): string[] {
  return entries
    .filter((entry) => {
      const sb = sbOf(entry);
      return entry.archivedAt === null && sb?.kind === DECK_DESIGN_READING_KIND && Array.isArray(sb.sourceVersionIds) && sb.sourceVersionIds.includes(documentId);
    })
    .map((entry) => entry.id);
}

/**
 * The documents that apply to one project, in the order they are read: the
 * project's own first, then the workspace's unless the project has turned
 * those off. Where two disagree, the nearer one comes first; the first
 * PowerPoint among them is the one whose theme draws the slides.
 */
export function effectiveDesignDocuments(args: {
  readonly workspace: readonly DeckDesignDocument[];
  readonly project: readonly DeckDesignDocument[];
  readonly settings: ProjectDeckSettings;
}): DeckDesignDocument[] {
  return [...args.project, ...(args.settings.useWorkspaceDesignDocuments ? args.workspace : [])];
}

/** The theme the slides are drawn with: the first document that carries one, or null for the built-in look. */
export function designThemeOf(documents: readonly DeckDesignDocument[]): TemplateTheme | null {
  return documents.find((document) => document.theme !== null)?.theme ?? null;
}

export type DesignReading = {
  readonly name: string;
  readonly scope: DesignDocumentScope;
  readonly text: string;
};

/** Characters of the guidelines block one request carries, all documents together. */
export const DESIGN_GUIDELINES_CAP = 30_000;
/** Characters of one document the block carries; the rest is noted as left out. */
export const DESIGN_READING_CAP = 12_000;

/** The heading the presentation creator finds the guidelines under. */
export const DESIGN_GUIDELINES_HEADING =
  "--- DESIGN GUIDELINES FOR THE DECK (follow these in the deck outline: its structure, emphasis, tone and wording; an existing presentation shows the house style) ---";

/**
 * The block the presentation creator is handed with a package request: the
 * role's own guidance, then each design document's text under its name,
 * nearest first. Capped, never silently: a document cut short says how
 * much was left out, and one left out entirely is named. Null when there
 * is nothing to say, so a request without guidelines reads as it always did.
 */
export function designGuidelinesBlock(readings: readonly DesignReading[], roleGuidance: string): string | null {
  const parts: string[] = [];
  const guidance = roleGuidance.trim();
  if (guidance.length > 0) parts.push(`What this stakeholder's deck should emphasise, in the person's words:\n${guidance}`);
  let budget = DESIGN_GUIDELINES_CAP;
  const leftOut: string[] = [];
  for (const reading of readings) {
    const text = reading.text.trim();
    if (text.length === 0) continue;
    const head = `### ${reading.name} (${reading.scope === "project" ? "this project's own" : "the workspace's"})`;
    const body =
      text.length > DESIGN_READING_CAP
        ? `${text.slice(0, DESIGN_READING_CAP)}\n(${String(text.length - DESIGN_READING_CAP)} more characters not shown)`
        : text;
    const cost = head.length + body.length + 2;
    if (cost > budget) {
      leftOut.push(reading.name);
      continue;
    }
    budget -= cost;
    parts.push(`${head}\n${body}`);
  }
  if (leftOut.length > 0) parts.push(`(Not shown, for length: ${leftOut.join(", ")}.)`);
  if (parts.length === 0) return null;
  return `${DESIGN_GUIDELINES_HEADING}\n\n${parts.join("\n\n")}`;
}

/**
 * The line that tells the presentation creator what `theme` to hand
 * `render_deck`, so the deck the workflow itself records carries the house
 * look and not the built-in one. Null when there is no theme to pass.
 */
export function renderDeckThemeLine(theme: TemplateTheme | null): string | null {
  if (!theme || Object.keys(theme).length === 0) return null;
  return `When you call render_deck, pass this as its \`theme\` argument, exactly, so the slides carry the house look: ${JSON.stringify(theme)}`;
}
