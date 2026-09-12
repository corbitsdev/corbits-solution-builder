/**
 * A slide deck for each stakeholder, built from the deck outline in their
 * package. The package is the record; the deck is a derivative of it, made
 * here without a model call, one slide per outline item, and kept as an
 * artifact version beside the package so it is exported, imported and
 * listed with everything else.
 */
import PptxGenJS from "pptxgenjs";
import type { ArtifactKind } from "@solutions-builder/app/artifacts";
import { agentFor } from "@solutions-builder/app/kit";
import { HostError, notFound } from "./errors.js";
import { artifactGraph, readArtifactNode, writeArtifact } from "./projects.js";
import { readProject } from "./project-tenant.js";

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

/** A body split into the sentences a slide shows; a "Source:" sentence stays in the notes. */
function bulletsOf(body: string): string[] {
  const text = plain(body).replace(/\s*Source:.*$/i, "");
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.slice(0, 5);
}

/**
 * The deck outline's numbered items: each a title in bold and a body under
 * it. An item without bold text takes its whole first line as the title.
 */
export function outlineSlidesIn(markdown: string): DeckSlide[] {
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
      return { title: item.title, bullets: bulletsOf(body), notes: plain(body) };
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

export function deckFrom(args: { projectTitle: string; audience: string; role: string; markdown: string }): Deck | null {
  const slides = outlineSlidesIn(args.markdown);
  if (slides.length === 0) return null;
  return {
    projectTitle: args.projectTitle,
    audience: args.audience,
    role: args.role,
    slides,
    decision: decisionLinesIn(args.markdown),
  };
}

/** A face PowerPoint carries everywhere and Keynote substitutes cleanly; a viewer's fallback serif reads as unfinished. */
const FACE = "Calibri";
const INK = "1F2933";
const MUTED = "6B7280";
const ACCENT = "B45309";

/** The deck as PowerPoint bytes: a title slide, one slide per outline item, and the decision request. */
export async function renderDeck(deck: Deck): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = `${deck.projectTitle} — for ${deck.audience}`;
  const footer = (slide: PptxGenJS.Slide, page: number) => {
    slide.addText(`${deck.projectTitle} · for ${deck.audience} · ${page}`, {
      x: 0.5,
      y: 5.1,
      w: 9,
      h: 0.3,
      fontSize: 9,
      fontFace: FACE,
      color: MUTED,
    });
  };

  const cover = pptx.addSlide();
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 5.625, fill: { color: ACCENT } });
  cover.addText(deck.projectTitle, { x: 0.7, y: 1.4, w: 8.6, h: 1.4, fontSize: 32, fontFace: FACE, bold: true, color: INK, valign: "bottom" });
  cover.addText(`Prepared for ${deck.audience} · ${deck.role}`, { x: 0.7, y: 2.9, w: 8.6, h: 0.5, fontSize: 16, fontFace: FACE, color: MUTED });
  cover.addText("Is this worth pursuing? Rough figures throughout; a firm estimate follows at stage 7.", {
    x: 0.7,
    y: 3.5,
    w: 8.6,
    h: 0.6,
    fontSize: 12,
    fontFace: FACE,
    color: MUTED,
  });

  deck.slides.forEach((entry, index) => {
    const slide = pptx.addSlide();
    slide.addText(entry.title, { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 24, fontFace: FACE, bold: true, color: INK, valign: "top" });
    slide.addShape(pptx.ShapeType.line, { x: 0.5, y: 1.3, w: 9, h: 0, line: { color: ACCENT, width: 1.5 } });
    slide.addText(
      entry.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 1.5, w: 9, h: 3.5, fontSize: 15, fontFace: FACE, color: INK, valign: "top", paraSpaceAfter: 6 },
    );
    if (entry.notes) slide.addNotes(entry.notes);
    footer(slide, index + 2);
  });

  if (deck.decision.length > 0) {
    const slide = pptx.addSlide();
    slide.addText("Decision request", { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 24, fontFace: FACE, bold: true, color: INK, valign: "top" });
    slide.addShape(pptx.ShapeType.line, { x: 0.5, y: 1.3, w: 9, h: 0, line: { color: ACCENT, width: 1.5 } });
    slide.addText(
      deck.decision.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 1.5, w: 9, h: 3.5, fontSize: 15, fontFace: FACE, color: INK, valign: "top", paraSpaceAfter: 6 },
    );
    footer(slide, deck.slides.length + 2);
  }

  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(out);
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
}): Promise<{ nodeId: string; version: number } | null> {
  const deck = deckFrom({
    projectTitle: args.projectTitle,
    audience: args.audience.name,
    role: args.audience.role.replace(/_/g, " "),
    markdown: args.markdown,
  });
  if (!deck) return null;
  const bytes = await renderDeck(deck);
  const written = await writeArtifact(
    {
      projectId: args.projectId,
      kind: DECK_KIND,
      variant: args.audience.name,
      title: `Slides for ${args.audience.name}`,
      content: `data:${DECK_MEDIA_TYPE};base64,${Buffer.from(bytes).toString("base64")}`,
      mediaType: DECK_MEDIA_TYPE,
      sourceVersionIds: [args.packageNodeId],
      provenance: { producer: "agent", agentRole: args.agentRole },
    },
    args.actor,
  );
  return { nodeId: written.nodeId, version: written.version };
}

/**
 * The deck built from this package version, building it now when none has
 * been: a package written before decks existed, or one whose build failed.
 * The person asks for slides from the package they can see, so the answer
 * is the slides for that version, never a rewrite of the package.
 */
export async function ensureDeckFor(args: {
  packageNodeId: string;
  actor: { principalId: string };
}): Promise<{ nodeId: string; built: boolean }> {
  const { node, content } = await readArtifactNode(args.packageNodeId);
  if (node.kind !== "audience_package") {
    throw new HostError("validation_failed", "Slides are built from a stakeholder's package.", {}, false);
  }
  const { nodes, edges } = await artifactGraph(node.projectId);
  const existing = nodes.find(
    (candidate) =>
      candidate.kind === DECK_KIND &&
      candidate.supersededByNodeId === null &&
      edges.some((edge) => edge.childNodeId === candidate.id && edge.sourceNodeId === node.id),
  );
  if (existing) return { nodeId: existing.id, built: false };

  const project = await readProject(node.projectId);
  if (!project) throw notFound("That project");
  const audience = project.policy.audiences?.find((entry) => entry.name === node.variant) ?? {
    name: node.variant ?? "Stakeholder",
    role: "stakeholder",
  };
  const written = await writeDeckFor({
    projectId: node.projectId,
    projectTitle: project.title,
    audience,
    packageNodeId: node.id,
    markdown: content,
    agentRole: agentFor(5).id,
    actor: args.actor,
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
