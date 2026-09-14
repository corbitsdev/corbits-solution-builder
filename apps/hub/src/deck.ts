/**
 * A slide deck for each stakeholder, built from the deck outline in their
 * package. The package is the record; the deck is a derivative of it, made
 * here without a model call, one slide per outline item, and kept as an
 * artifact version beside the package so it is exported, imported and
 * listed with everything else.
 */
import PptxGenJS from "pptxgenjs";
import type { ArtifactKind } from "@solutions-builder/app/artifacts";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFor } from "@solutions-builder/app/kit";
import { dataDirectory } from "./paths.js";
import { HostError, notFound } from "./errors.js";
import { artifactGraph, readArtifactNode, writeArtifact } from "./projects.js";
import { readProject } from "./project-tenant.js";
import {
  DECK_DENSITY,
  DECK_THEMES,
  DEFAULT_DECK_DESIGN,
  deckDesignFor,
  deckDesignHash,
  type DeckDesign,
} from "./deck-settings.js";
import { templateFor, templateThemeFor, type TemplateTheme } from "./deck-template.js";
import { renderDeckOnTemplate } from "./deck-on-template.js";
import { artDirection, chatSource, illustration, illustrationPrompt, imageSource } from "./deck-images.js";

/** The kind a deck is recorded as: stage 5, one per stakeholder, never a prompt input. */
export const DECK_KIND: ArtifactKind = "audience_deck";
export const DECK_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type DeckSlide = {
  readonly title: string;
  /** What is shown on the slide: the item's body, sentence by sentence. */
  readonly bullets: readonly string[];
  /** What is said: the item's body in full, sources included. */
  readonly notes: string;
};

export type Deck = {
  readonly projectTitle: string;
  readonly audience: string;
  readonly role: string;
  readonly slides: readonly DeckSlide[];
  /** The package's decision request, as the closing slide's lines. */
  readonly decision: readonly string[];
  /** The look the role's settings ask for. */
  readonly design: DeckDesign;
  /** What the role's style guide, when there is one, changes about the look. */
  readonly theme?: TemplateTheme;
  /** Illustrations by slide: "cover", or an item's index as a string. PNG bytes. */
  readonly images?: ReadonlyMap<string, Uint8Array>;
};

/** The text under a `### heading`, up to the next heading of the same or a higher level. */
function sectionIn(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^###\s+/.test(line) && line.replace(/^###\s+/, "").trim().toLowerCase() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##{1,2}\s+/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Plain text from a line of Markdown: emphasis, code and citation brackets removed. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A body split into the sentences a slide shows, up to `most`; a "Source:" sentence stays in the notes. */
function bulletsOf(body: string, most: number): string[] {
  const text = plain(body).replace(/\s*Source:.*$/i, "");
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.slice(0, most);
}

/**
 * The deck outline's numbered items: each a title in bold and a body under
 * it. An item without bold text takes its whole first line as the title.
 */
export function outlineSlidesIn(markdown: string, most = DECK_DENSITY[DEFAULT_DECK_DESIGN.density]): DeckSlide[] {
  const section = sectionIn(markdown, "deck outline");
  if (section === null) return [];
  const items: { title: string; body: string[] }[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const head = numbered[1]!;
      const bold = /\*\*(.+?)\*\*/.exec(head);
      const title = plain(bold ? bold[1]! : head);
      const after = bold ? plain(head.slice(head.indexOf(bold[0]) + bold[0].length)) : "";
      items.push({ title, body: after ? [after] : [] });
      continue;
    }
    const current = items.at(-1);
    if (!current) continue;
    if (line.trim() === "") continue;
    current.body.push(line.trim());
  }
  return items
    .filter((item) => item.title.length > 0)
    .map((item) => {
      const body = item.body.join(" ");
      return { title: item.title, bullets: bulletsOf(body, most), notes: plain(body) };
    });
}

/** The decision request's lines, bullets and paragraphs alike, as plain text. */
export function decisionLinesIn(markdown: string): string[] {
  const section = sectionIn(markdown, "decision request");
  if (section === null) return [];
  return section
    .split("\n")
    .map((line) => plain(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")))
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

export function deckFrom(args: {
  projectTitle: string;
  audience: string;
  role: string;
  markdown: string;
  design?: DeckDesign;
  theme?: TemplateTheme;
  images?: ReadonlyMap<string, Uint8Array>;
}): Deck | null {
  const design = args.design ?? DEFAULT_DECK_DESIGN;
  const slides = outlineSlidesIn(args.markdown, DECK_DENSITY[design.density]);
  if (slides.length === 0) return null;
  return {
    projectTitle: args.projectTitle,
    audience: args.audience,
    role: args.role,
    slides,
    decision: decisionLinesIn(args.markdown),
    design,
    ...(args.theme ? { theme: args.theme } : {}),
    ...(args.images ? { images: args.images } : {}),
  };
}

/** The look a deck is drawn with: the role's settings, with its style guide's theme over them. */
export type DeckLook = {
  readonly accent: string;
  readonly ink: string;
  readonly paper: string;
  readonly muted: string;
  readonly titleFace: string;
  readonly bodyFace: string;
  readonly wide: boolean;
};

export function lookOf(design: DeckDesign, theme?: TemplateTheme): DeckLook {
  return {
    accent: theme?.accent ?? DECK_THEMES[design.theme].accent,
    ink: theme?.ink ?? "1F2933",
    paper: theme?.paper ?? "FFFFFF",
    muted: "6B7280",
    titleFace: theme?.titleFace ?? theme?.bodyFace ?? design.typeface,
    bodyFace: theme?.bodyFace ?? design.typeface,
    wide: theme?.ratio === undefined || theme.ratio > 1.5,
  };
}

function pngData(bytes: Uint8Array): string {
  return `image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** The deck as PowerPoint bytes: a title slide, one slide per outline item, and the decision request. */
export async function renderDeck(deck: Deck): Promise<Uint8Array> {
  const look = lookOf(deck.design, deck.theme);
  const pptx = new PptxGenJS();
  pptx.layout = look.wide ? "LAYOUT_16x9" : "LAYOUT_4x3";
  const W = look.wide ? 10 : 10;
  const H = look.wide ? 5.625 : 7.5;
  pptx.title = `${deck.projectTitle} — for ${deck.audience}`;
  const footer = (slide: PptxGenJS.Slide, page: number) => {
    slide.addText(`${deck.projectTitle} · for ${deck.audience} · ${page}`, {
      x: 0.5,
      y: H - 0.5,
      w: W - 1,
      h: 0.3,
      fontSize: 9,
      fontFace: look.bodyFace,
      color: look.muted,
    });
  };
  const paint = (slide: PptxGenJS.Slide) => {
    if (look.paper !== "FFFFFF") slide.background = { color: look.paper };
  };

  const cover = pptx.addSlide();
  paint(cover);
  const coverImage = deck.images?.get("cover");
  const coverTextWidth = coverImage ? W * 0.52 : W - 1.4;
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: H, fill: { color: look.accent } });
  cover.addText(deck.projectTitle, { x: 0.7, y: H * 0.25, w: coverTextWidth, h: 1.4, fontSize: 32, fontFace: look.titleFace, bold: true, color: look.ink, valign: "bottom" });
  cover.addText(`Prepared for ${deck.audience} · ${deck.role}`, { x: 0.7, y: H * 0.25 + 1.5, w: coverTextWidth, h: 0.5, fontSize: 16, fontFace: look.bodyFace, color: look.muted });
  cover.addText("Is this worth pursuing? Rough figures throughout; a firm estimate follows at stage 7.", {
    x: 0.7,
    y: H * 0.25 + 2.1,
    w: coverTextWidth,
    h: 0.6,
    fontSize: 12,
    fontFace: look.bodyFace,
    color: look.muted,
  });
  if (coverImage) {
    cover.addImage({ data: pngData(coverImage), x: W * 0.58, y: 0.6, w: W * 0.38, h: H - 1.2, sizing: { type: "contain", w: W * 0.38, h: H - 1.2 } });
  }

  const itemSlide = (title: string, lines: readonly string[], notes: string | null, image: Uint8Array | undefined, page: number) => {
    const slide = pptx.addSlide();
    paint(slide);
    const textWidth = image ? W * 0.56 : W - 1;
    slide.addText(title, { x: 0.5, y: 0.35, w: W - 1, h: 0.9, fontSize: 24, fontFace: look.titleFace, bold: true, color: look.ink, valign: "top" });
    slide.addShape(pptx.ShapeType.line, { x: 0.5, y: 1.3, w: W - 1, h: 0, line: { color: look.accent, width: 1.5 } });
    slide.addText(
      lines.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 1.5, w: textWidth, h: H - 2.2, fontSize: 15, fontFace: look.bodyFace, color: look.ink, valign: "top", paraSpaceAfter: 6 },
    );
    if (image) {
      slide.addImage({ data: pngData(image), x: W * 0.62, y: 1.5, w: W * 0.34, h: H - 2.2, sizing: { type: "contain", w: W * 0.34, h: H - 2.2 } });
    }
    if (notes && deck.design.notes) slide.addNotes(notes);
    footer(slide, page);
  };

  deck.slides.forEach((entry, index) => {
    itemSlide(entry.title, entry.bullets, entry.notes, deck.images?.get(String(index)), index + 2);
  });
  if (deck.decision.length > 0) {
    itemSlide("Decision request", deck.decision, null, undefined, deck.slides.length + 2);
  }

  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(out);
}

/**
 * The illustrations a role's design asks for. A chat model that has read the
 * whole deck says which slides deserve a picture and what each should show;
 * the provider's image model then draws those, in the house manner. Null
 * when the design asks for none. Throws when it asks and no connected
 * provider can read or draw.
 */
export async function illustrationsFor(deck: Deck): Promise<Map<string, Uint8Array> | null> {
  if (deck.design.images === "none") return null;
  const source = await imageSource();
  if (!source) {
    throw new HostError(
      "provider_unavailable",
      "The slides ask for images, but no connected provider lists an image model (gpt-image-1, dall-e-3 or a Grok image model). Connect one, or set Images to none for this role in Settings, Stakeholder decks.",
      {},
      false,
    );
  }
  const reader = await chatSource();
  if (!reader) {
    throw new HostError(
      "provider_unavailable",
      "The slides ask for images, but no connected provider has a chat model to read the deck with. Connect one, or set Images to none for this role in Settings, Stakeholder decks.",
      {},
      false,
    );
  }
  const direction = await artDirection({
    source: reader,
    mode: deck.design.images,
    projectTitle: deck.projectTitle,
    audience: deck.audience,
    role: deck.role,
    guidance: deck.design.guidance,
    slides: deck.slides,
    decision: deck.decision,
  });
  const colour = DECK_THEMES[deck.design.theme].label.toLowerCase();
  const images = new Map<string, Uint8Array>();
  for (const [key, subject] of direction) {
    images.set(key, await illustration(source, illustrationPrompt({ subject, colour })));
  }
  return images;
}

/**
 * The artifact store takes a version of at most 15 MiB, and a deck is kept
 * there as base64, a third larger than its bytes. A deck past this many
 * bytes is kept as a file in the data directory and its version records
 * where; it is rebuilt from the package if the file is ever gone.
 */
const STORE_LIMIT_BYTES = 11 * 1024 * 1024;

function deckFilesDirectory(): string {
  return join(dataDirectory(), "decks");
}

/** A deck version's content: the bytes as a data URI when they fit the store, else a pointer to the file. */
async function deckContent(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength <= STORE_LIMIT_BYTES) return `data:${DECK_MEDIA_TYPE};base64,${Buffer.from(bytes).toString("base64")}`;
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.pptx`;
  await mkdir(deckFilesDirectory(), { recursive: true });
  await writeFile(join(deckFilesDirectory(), name), bytes);
  return JSON.stringify({ deckFile: name, bytes: bytes.byteLength });
}

/** A deck version's bytes, from the store or from the file it points at; null when the file is gone. */
export async function deckBytesOf(content: string): Promise<Uint8Array | null> {
  const inline = /^data:[^;]+;base64,(.*)$/s.exec(content);
  if (inline) return new Uint8Array(Buffer.from(inline[1]!, "base64"));
  try {
    const pointer = JSON.parse(content) as { deckFile?: unknown };
    if (typeof pointer.deckFile !== "string" || !/^[a-f0-9]+\.pptx$/.test(pointer.deckFile)) return null;
    return new Uint8Array(await readFile(join(deckFilesDirectory(), pointer.deckFile)));
  } catch {
    return null;
  }
}

export function deckFileName(projectTitle: string, audience: string): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "slides";
  return `${slug(projectTitle)}-${slug(audience)}-slides.pptx`;
}

/**
 * Builds the stakeholder's deck from their package and records it as a
 * version of their `audience_deck`, built from the package version. Null
 * when the package carries no deck outline to build from.
 */
export async function writeDeckFor(args: {
  projectId: string;
  projectTitle: string;
  audience: { name: string; role: string };
  packageNodeId: string;
  markdown: string;
  agentRole: string;
  actor: { principalId: string };
  /**
   * Whether to draw the illustrations the role's design asks for. Off when
   * the deck is built as a package is written — the person is waiting on
   * the package, not on nine images — and on when they ask for the slides.
   */
  illustrate?: boolean;
}): Promise<{ nodeId: string; version: number } | null> {
  const design = await deckDesignFor(args.audience.role);
  const template = await templateFor(args.audience.role);
  const theme = template ? ((await templateThemeFor(args.audience.role)) ?? undefined) : undefined;
  const plain = deckFrom({
    projectTitle: args.projectTitle,
    audience: args.audience.name,
    role: args.audience.role.replace(/_/g, " "),
    markdown: args.markdown,
    design,
    ...(theme ? { theme } : {}),
  });
  if (!plain) return null;
  const images = args.illustrate ? await illustrationsFor(plain) : null;
  const deck: Deck = images ? { ...plain, images } : plain;
  // On the person's own PowerPoint when the role has one: its masters,
  // layouts and media, our slides. Otherwise drawn from the design.
  const bytes = template ? await renderDeckOnTemplate(template.bytes, deck) : await renderDeck(deck);
  const written = await writeArtifact(
    {
      projectId: args.projectId,
      kind: DECK_KIND,
      variant: args.audience.name,
      title: `Slides for ${args.audience.name}`,
      content: await deckContent(bytes),
      mediaType: DECK_MEDIA_TYPE,
      sourceVersionIds: [args.packageNodeId],
      // The look it was built with rides along, so a changed design is a new version.
      provenance: { producer: "agent", agentRole: args.agentRole, promptKey: designKey(design, template?.hash, images !== null) },
    },
    args.actor,
  );
  return { nodeId: written.nodeId, version: written.version };
}

/** How a deck's provenance names the look it was built with: the design, the style guide file, and whether it carries the images asked for. */
function designKey(design: DeckDesign, templateHash: string | undefined, illustrated: boolean): string {
  return `sb-deck-design:${deckDesignHash(design, [templateHash ?? null, design.images !== "none" ? illustrated : true])}`;
}

/**
 * The deck built from this package version with the role's current design,
 * building it now when none has been: a package written before decks
 * existed, one whose build failed, or one whose role's design has changed
 * since. The person asks for slides from the package they can see, so the
 * answer is the slides for that version, never a rewrite of the package.
 */
export async function ensureDeckFor(args: {
  packageNodeId: string;
  actor: { principalId: string };
}): Promise<{ nodeId: string; built: boolean }> {
  // A second request for slides still being built joins the build rather
  // than starting another: a build draws images and records a version, and
  // two of each for one press-twice is a mess the person did not ask for.
  const inFlight = building.get(args.packageNodeId);
  if (inFlight) return inFlight;
  const build = findOrBuildDeck(args).finally(() => building.delete(args.packageNodeId));
  building.set(args.packageNodeId, build);
  return build;
}

/** The builds under way, by package version, for the request that arrives mid-build. */
const building = new Map<string, Promise<{ nodeId: string; built: boolean }>>();

async function findOrBuildDeck(args: {
  packageNodeId: string;
  actor: { principalId: string };
}): Promise<{ nodeId: string; built: boolean }> {
  const { node, content } = await readArtifactNode(args.packageNodeId);
  if (node.kind !== "audience_package") {
    throw new HostError("validation_failed", "Slides are built from a stakeholder's package.", {}, false);
  }
  const project = await readProject(node.projectId);
  if (!project) throw notFound("That project");
  const audience = project.policy.audiences?.find((entry) => entry.name === node.variant) ?? {
    name: node.variant ?? "Stakeholder",
    role: "stakeholder",
  };
  const { nodes, edges } = await artifactGraph(node.projectId);
  const current = designKey(await deckDesignFor(audience.role), (await templateFor(audience.role))?.hash, true);
  const existing = nodes.find(
    (candidate) =>
      candidate.kind === DECK_KIND &&
      candidate.supersededByNodeId === null &&
      edges.some((edge) => edge.childNodeId === candidate.id && edge.sourceNodeId === node.id) &&
      (candidate.provenance as { promptKey?: unknown } | null)?.promptKey === current,
  );
  // A version whose bytes live in a file that is gone is no deck at all.
  if (existing && (await deckBytesOf((await readArtifactNode(existing.id)).content)) !== null) return { nodeId: existing.id, built: false };
  const written = await writeDeckFor({
    projectId: node.projectId,
    projectTitle: project.title,
    audience,
    packageNodeId: node.id,
    markdown: content,
    agentRole: agentFor(5).id,
    actor: args.actor,
    illustrate: true,
  });
  if (!written) {
    throw new HostError(
      "validation_failed",
      "This package has no \"Deck outline\" section with numbered items, so there is nothing to build slides from.",
      {},
      false,
    );
  }
  return { nodeId: written.nodeId, built: true };
}
