import { describe, expect, test } from "bun:test";
import {
  DESIGN_GUIDELINES_CAP,
  DESIGN_GUIDELINES_HEADING,
  DESIGN_READING_CAP,
  designDocumentFormat,
  designDocumentRefusal,
  designDocumentsFrom,
  designGuidelinesBlock,
  designThemeOf,
  effectiveDesignDocuments,
  readingIdsFor,
  renderDeckThemeLine,
  themeFrom,
  type DeckDesignDocument,
  type DesignArtifactEntry,
} from "./deck-design-documents.ts";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function entry(id: string, sb: Record<string, unknown> | null, overrides: Partial<DesignArtifactEntry> = {}): DesignArtifactEntry {
  return { id, title: id, archivedAt: null, createdAt: `2026-09-0${id.length % 9 + 1}T00:00:00.000Z`, metadata: sb ? { sb } : null, ...overrides };
}

function document(overrides: Partial<DeckDesignDocument>): DeckDesignDocument {
  return { id: "d", name: "d", mediaType: "text/plain", format: "text", scope: "workspace", theme: null, textRead: true, readingId: "d", createdAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

describe("designDocumentFormat", () => {
  test("names text, Markdown, PDF and PowerPoint by type or extension", () => {
    expect(designDocumentFormat("guide.md", "")).toBe("text");
    expect(designDocumentFormat("guide.txt", "text/plain")).toBe("text");
    expect(designDocumentFormat("GUIDE.MARKDOWN", "")).toBe("text");
    expect(designDocumentFormat("deck.pdf", "application/pdf")).toBe("pdf");
    expect(designDocumentFormat("deck.PPTX", "")).toBe("pptx");
    expect(designDocumentFormat("deck", PPTX)).toBe("pptx");
  });

  test("refuses anything else by name, with the kinds that are read", () => {
    expect(designDocumentFormat("logo.png", "image/png")).toBeNull();
    expect(designDocumentRefusal("logo.png", "image/png")).toBe("logo.png is not read as a design document: only text, Markdown, PDF and PowerPoint files are.");
    expect(designDocumentRefusal("deck.pptx", PPTX)).toBeNull();
  });
});

describe("themeFrom", () => {
  test("keeps only the theme's known fields, typed", () => {
    expect(themeFrom({ accent: "B45309", ratio: 1.78, ink: 12, extra: "x" })).toEqual({ accent: "B45309", ratio: 1.78 });
    expect(themeFrom({ accent: "" })).toBeNull();
    expect(themeFrom("nope")).toBeNull();
    expect(themeFrom(null)).toBeNull();
  });
});

describe("designDocumentsFrom", () => {
  const entries: DesignArtifactEntry[] = [
    entry("guide", { kind: "deck_design_document", variant: "guide.md", mediaType: "text/markdown" }, { createdAt: "2026-09-01T00:00:00.000Z" }),
    entry("deck", { kind: "deck_design_document", variant: "last-year.pptx", mediaType: PPTX, theme: { accent: "1E3A8A", titleFace: "Georgia" } }, { createdAt: "2026-09-03T00:00:00.000Z" }),
    entry("deck-reading", { kind: "deck_design_reading", variant: "last-year.pptx", sourceVersionIds: ["deck"] }),
    entry("scan", { kind: "deck_design_document", variant: "scan.pdf", mediaType: "application/pdf", textRead: false, theme: { paper: "F8F8F8", accent: "183888", ratio: 1.78 } }, { createdAt: "2026-09-02T00:00:00.000Z" }),
    entry("gone", { kind: "deck_design_document", variant: "gone.md", mediaType: "text/markdown" }, { archivedAt: "2026-09-04T00:00:00.000Z" }),
    entry("package", { kind: "audience_package", projectId: "p1", variant: "You" }),
    entry("no-sb", null),
  ];

  test("lists live design documents newest first, each with its reading and theme", () => {
    const documents = designDocumentsFrom(entries, "workspace");
    expect(documents.map((document) => document.name)).toEqual(["last-year.pptx", "scan.pdf", "guide.md"]);
    const [deck, scan, guide] = documents as [DeckDesignDocument, DeckDesignDocument, DeckDesignDocument];
    expect(deck).toMatchObject({ format: "pptx", scope: "workspace", readingId: "deck-reading", theme: { accent: "1E3A8A", titleFace: "Georgia" } });
    // A picture-only PDF has no reading companion and no text, but its look was read (#254).
    expect(scan).toMatchObject({ format: "pdf", readingId: null, textRead: false, theme: { paper: "F8F8F8", accent: "183888", ratio: 1.78 } });
    // A text document is its own reading, and its text always counts as read.
    expect(guide).toMatchObject({ format: "text", readingId: "guide", theme: null, textRead: true });
    expect(deck.textRead).toBe(true);
  });

  test("the reading companions of a document are what a remove archives beside it", () => {
    expect(readingIdsFor(entries, "deck")).toEqual(["deck-reading"]);
    expect(readingIdsFor(entries, "guide")).toEqual([]);
  });
});

describe("effectiveDesignDocuments", () => {
  const workspace = [document({ id: "w1", name: "w1.md" }), document({ id: "w2", name: "w2.pptx", format: "pptx", theme: { accent: "111111" } })];
  const project = [document({ id: "p1", name: "p1.pptx", scope: "project", format: "pptx", theme: { accent: "222222" } })];

  test("a project's own documents come first, then the workspace's", () => {
    const documents = effectiveDesignDocuments({ workspace, project, settings: { useWorkspaceDesignDocuments: true } });
    expect(documents.map((document) => document.id)).toEqual(["p1", "w1", "w2"]);
    expect(designThemeOf(documents)).toEqual({ accent: "222222" });
  });

  test("a project that turned the workspace's off keeps only its own", () => {
    const documents = effectiveDesignDocuments({ workspace, project, settings: { useWorkspaceDesignDocuments: false } });
    expect(documents.map((document) => document.id)).toEqual(["p1"]);
    expect(effectiveDesignDocuments({ workspace, project: [], settings: { useWorkspaceDesignDocuments: false } })).toEqual([]);
  });

  test("the theme is the first document carrying one, or null for the built-in look", () => {
    expect(designThemeOf(effectiveDesignDocuments({ workspace, project: [], settings: { useWorkspaceDesignDocuments: true } }))).toEqual({ accent: "111111" });
    expect(designThemeOf([document({})])).toBeNull();
  });
});

describe("designGuidelinesBlock", () => {
  test("is null when there is nothing to say, so a request reads as before", () => {
    expect(designGuidelinesBlock([], "")).toBeNull();
    expect(designGuidelinesBlock([{ name: "empty.md", scope: "workspace", text: "   " }], "  ")).toBeNull();
  });

  test("leads with the role's guidance, then each document under its name, nearest first", () => {
    const block = designGuidelinesBlock(
      [
        { name: "ours.md", scope: "project", text: "Lead with the number." },
        { name: "house.md", scope: "workspace", text: "Navy and white. No clip art." },
      ],
      "Keep it to the money.",
    )!;
    expect(block).toStartWith(DESIGN_GUIDELINES_HEADING);
    expect(block).toContain("What this stakeholder's deck should emphasise, in the person's words:\nKeep it to the money.");
    expect(block).toContain("### ours.md (this project's own)\nLead with the number.");
    expect(block).toContain("### house.md (the workspace's)\nNavy and white. No clip art.");
    expect(block.indexOf("ours.md")).toBeLessThan(block.indexOf("house.md"));
  });

  test("a long document is cut with the count left out, never silently", () => {
    const block = designGuidelinesBlock([{ name: "long.md", scope: "workspace", text: "x".repeat(DESIGN_READING_CAP + 500) }], "")!;
    expect(block).toContain("(500 more characters not shown)");
    expect(block.length).toBeLessThan(DESIGN_READING_CAP + 400);
  });

  test("documents past the block's own cap are named as left out", () => {
    const readings = Array.from({ length: 4 }, (_, index) => ({ name: `doc${String(index)}.md`, scope: "workspace" as const, text: "y".repeat(DESIGN_READING_CAP) }));
    const block = designGuidelinesBlock(readings, "")!;
    expect(block.length).toBeLessThan(DESIGN_GUIDELINES_CAP + 200);
    expect(block).toContain("### doc0.md");
    expect(block).toContain("### doc1.md");
    expect(block).toContain("(Not shown, for length: doc2.md, doc3.md.)");
  });
});

describe("renderDeckThemeLine", () => {
  test("tells the presentation creator the exact theme to hand render_deck, or nothing", () => {
    expect(renderDeckThemeLine(null)).toBeNull();
    expect(renderDeckThemeLine({})).toBeNull();
    expect(renderDeckThemeLine({ accent: "1E3A8A", ratio: 1.78 })).toBe(
      'When you call render_deck, pass this as its `theme` argument, exactly, so the slides carry the house look: {"accent":"1E3A8A","ratio":1.78}',
    );
  });
});
