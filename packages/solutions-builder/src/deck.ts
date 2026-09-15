/**
 * Deck authoring: turning a package's "Deck outline" and "Decision request"
 * sections into a `Deck`, and a `Deck` into PowerPoint bytes.
 *
 * This is the default local Documents provider's presentation authoring —
 * Build Plan V3 §9's "always-available local … presentations". It is pure:
 * given markdown, a look and (optionally) pre-drawn illustrations, it
 * returns bytes. It knows nothing of artifact storage, provider credentials,
 * or the host's data directory — that is `apps/hub`'s job, not this one's.
 */
import PptxGenJS from "pptxgenjs";

/** The media type a deck is stored and served as. */
export const DECK_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** The heading a package's slides are read from. */
export const OUTLINE_HEADING = "Deck outline";

export type DeckSlide = {
  readonly title: string;
  /** What is shown on the slide: the item's body, sentence by sentence. */
  readonly bullets: readonly string[];
  /** What is said: the item's body in full, sources included. */
  readonly notes: string;
};

/** How much a slide carries: the most bullets an outline item is shown as. */
export const DECK_DENSITY = { sparse: 3, standard: 5, full: 7 } as const;
export type DeckDensity = keyof typeof DECK_DENSITY;

export const DECK_THEMES = {
  ember: { label: "Ember", accent: "B45309" },
  slate: { label: "Slate", accent: "334155" },
  forest: { label: "Forest", accent: "166534" },
  navy: { label: "Navy", accent: "1E3A8A" },
  plum: { label: "Plum", accent: "6B21A8" },
} as const;
export type DeckTheme = keyof typeof DECK_THEMES;

export const DECK_TYPEFACES = ["Calibri", "Georgia", "Arial", "Helvetica"] as const;
export type DeckTypeface = (typeof DECK_TYPEFACES)[number];

/** The look and content choices a deck is built with; the host resolves these from a role's saved settings. */
export type DeckDesign = {
  theme: DeckTheme;
  typeface: DeckTypeface;
  density: DeckDensity;
  /** Whether each slide carries the item's full text as speaker notes. */
  notes: boolean;
  /** Which slides carry an illustration; the host draws them before calling in here. */
  images: "none" | "cover" | "some" | "all";
  /** The file name of the PowerPoint kept as this role's style guide, or null. */
  template: string | null;
  /** What this role's deck outline should emphasise, in the person's words. */
  guidance: string;
};

export const DEFAULT_DECK_DESIGN: DeckDesign = {
  theme: "ember",
  typeface: "Calibri",
  density: "standard",
  notes: true,
  images: "none",
  template: null,
  guidance: "",
};

/** What a style guide's theme contributes to a deck's look. Every field optional: a theme names what it names. */
export type TemplateTheme = {
  readonly accent?: string;
  readonly ink?: string;
  readonly paper?: string;
  readonly titleFace?: string;
  readonly bodyFace?: string;
  /** Width over height; 16:9 is 1.78, 4:3 is 1.33. */
  readonly ratio?: number;
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
  const section = sectionIn(markdown, OUTLINE_HEADING.toLowerCase());
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

/**
 * Why a package cannot be one, or null when it can: every package carries a
 * "### Deck outline" section with at least one numbered slide, because that
 * is what its stakeholder's slides are built from. The sentence is written
 * for the person reading the refusal.
 */
export function packageOutlineProblem(markdown: string): string | null {
  if (sectionIn(markdown, OUTLINE_HEADING.toLowerCase()) === null) {
    return `it has no "### ${OUTLINE_HEADING}" section, and a package's slides are built from that outline`;
  }
  if (outlineSlidesIn(markdown).length === 0) {
    return `its "### ${OUTLINE_HEADING}" section has no numbered slides (one per line, "1. **Title** — what the slide says"), and a package's slides are built from those`;
  }
  return null;
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

/** A deck's file name: the project and the stakeholder, slugged. */
export function deckFileName(projectTitle: string, audience: string): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "slides";
  return `${slug(projectTitle)}-${slug(audience)}-slides.pptx`;
}
