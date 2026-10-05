/**
 * A recorded stakeholder deck opened from the artifact strip (#249): the
 * slides drawn on screen, and the same three ways out stage 5's own page
 * offers, instead of a bare file card with one Download button.
 *
 * The recorded file is PowerPoint bytes, which nothing here can draw; the
 * preview is rebuilt the way stage 5 builds it — from the sibling package's
 * deck outline, with the role's saved design and the theme the deck's brief
 * resolves, and the approved design's screens where there is an HTML
 * mockup. "Save as PPTX" saves the recorded file itself: it is the artifact
 * the person opened, not a rebuild. PDF prints the rebuilt slides, and Google
 * Slides gets the file saved and Slides opened for the import, as on stage 5.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui";
import { deckFrom, packageOutlineProblem, type Deck } from "@solutions-builder/app/deck";
import { api, ApiFailure, type ArtifactNode } from "../../client.js";
import { Button, downloadArtifact } from "../../components.jsx";
import { deckDesignFor } from "../../deck-design-settings.ts";
import { buildPackageDeck, deckFileName } from "../../deck-save.ts";
import { mockupShots, placeMockups, type MockupShot } from "../../mockup-shots.ts";
import { printHtmlDocument } from "../../print.jsx";
import { slidesPrintHtml } from "../../slides-print.ts";
import { isDataUrl } from "../../binary-file.tsx";
import { isHtmlDocument } from "./guidance.ts";

/**
 * The package a recorded deck was built from: the same stakeholder's, at
 * the same stage, the newest one that already existed when the deck was
 * recorded — a later rewrite is not what these slides say. Null when no
 * package for that stakeholder is in the record at all.
 */
export function packageForDeck(nodes: readonly ArtifactNode[], deck: ArtifactNode): ArtifactNode | null {
  const siblings = nodes
    .filter((node) => node.kind === "audience_package" && node.stage === deck.stage && node.variant === deck.variant)
    .sort((a, b) => b.version - a.version || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return siblings.find((node) => Date.parse(node.createdAt) <= Date.parse(deck.createdAt)) ?? siblings[0] ?? null;
}

/** The recorded file's download name: its title, given the extension once. */
export function recordedDeckFileName(title: string): string {
  return /\.pptx$/i.test(title) ? title : `${title}.pptx`;
}

export type RecordedDeckView = {
  /** The rebuilt slides, or null while loading or when they cannot be rebuilt. */
  readonly deck: Deck | null;
  /** What the preview cannot show, or why there is none. */
  readonly note: string | null;
  /** The Export slides menu for the document's head. */
  readonly exportMenu: ReactNode;
  /** What the last export said, if anything. */
  readonly notice: string | null;
};

export function useRecordedDeck(args: {
  /** The open `audience_deck` node, or null when the reader shows something else. */
  readonly node: ArtifactNode | null;
  readonly nodes: readonly ArtifactNode[];
  readonly tenantId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly audiences: readonly { readonly name: string; readonly role: string }[];
  /** The approved stage 4 design's artifact id, whose screens fill the slides. */
  readonly designRef: string | null;
  /** The recorded file as the reader loaded it: a data: URL once it is here. */
  readonly content: string;
  /** A redrawn deck was recorded (#760): the project's artifact graph should be re-read. */
  readonly onRecorded?: () => void;
}): RecordedDeckView {
  const { node, nodes, tenantId, projectId, projectTitle, audiences, designRef, content, onRecorded } = args;
  const [built, setBuilt] = useState<{ forId: string; deck: Deck | null; note: string | null }>({ forId: "", deck: null, note: null });
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const nodeId = node?.id ?? null;
  const variant = node?.variant ?? null;
  const packageNode = node ? packageForDeck(nodes, node) : null;
  const packageId = packageNode?.id ?? null;
  const role = audiences.find((audience) => audience.name === variant)?.role ?? "";

  useEffect(() => {
    setNotice(null);
    if (!nodeId) return;
    if (!packageId) {
      setBuilt({ forId: nodeId, deck: null, note: "No slides to show: the package these slides were built from is not in the record. The saved file is still what it was." });
      return;
    }
    let cancelled = false;
    void (async () => {
      const [pkg, brief, preferences, designHtml] = await Promise.all([
        api.artifactContent(tenantId, packageId).then((result) => result.content),
        api.deckBrief(projectId, role).then(
          (loaded) => ({ theme: loaded.theme, failed: false }),
          () => ({ theme: null, failed: true }),
        ),
        api.deckDesigns().then(
          (loaded) => loaded as Record<string, unknown>,
          () => ({}) as Record<string, unknown>,
        ),
        designRef ? api.artifactContent(tenantId, designRef).then((result) => (isHtmlDocument(result.content) ? result.content : null), () => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const problem = packageOutlineProblem(pkg);
      if (problem) {
        setBuilt({ forId: nodeId, deck: null, note: `No slides to show: the package ${problem}. The saved file is still what it was.` });
        return;
      }
      const deck = deckFrom({
        projectTitle,
        audience: variant ?? "",
        role,
        markdown: pkg,
        design: deckDesignFor(role, preferences),
        ...(brief.theme ? { theme: brief.theme } : {}),
      });
      if (!deck) {
        setBuilt({ forId: nodeId, deck: null, note: "No slides to show: the package's deck outline has no slides." });
        return;
      }
      const shots = designHtml ? await mockupShots(designHtml).catch(() => [] as MockupShot[]) : [];
      if (cancelled) return;
      const pictured = shots.length > 0 ? { ...deck, images: placeMockups(deck, shots) } : deck;
      const notes = [
        "Drawn again from the package's deck outline with the current design; the saved file is what Save as PPTX gives until Redraw with the current design records it.",
        brief.failed ? "Its design documents could not be read, so this is the default look." : null,
        designHtml && shots.length === 0 ? "The design's screens could not be captured for the slides." : null,
      ].filter((line): line is string => line !== null);
      setBuilt({ forId: nodeId, deck: pictured, note: notes.join(" ") });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, packageId, role, tenantId, projectId, projectTitle, designRef]);

  const current = node && built.forId === node.id ? built : { deck: null, note: null };

  const exportSlides = async (how: "pptx" | "pdf" | "google") => {
    if (!node) return;
    setExporting(true);
    setNotice(null);
    try {
      const fileBase = deckFileName(projectTitle, variant ?? node.title).replace(/\.pptx$/, "");
      if (how === "pdf") {
        if (!current.deck) throw new Error(current.note ?? "the slides could not be drawn.");
        printHtmlDocument(slidesPrintHtml(current.deck, fileBase));
      } else {
        const bytes = isDataUrl(content) ? content : (await api.artifactContent(tenantId, node.id)).content;
        downloadArtifact(bytes, recordedDeckFileName(node.title));
        if (how === "google") {
          window.open("https://docs.google.com/presentation/u/0/", "_blank", "noopener");
          setNotice(
            `The PowerPoint is saved. In Google Slides choose File → Import slides and pick ${recordedDeckFileName(node.title)}; nothing here is signed in to Google to upload it for you.`,
          );
        }
      }
    } catch (cause) {
      toast.error(`Slides could not be exported: ${cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  };

  // The recorded file, drawn again with the design as it stands now (#760):
  // the role's saved look, the uploaded design documents' theme and the
  // approved GUI's screens, recorded as the next version of these slides.
  const redraw = async () => {
    if (!node || !packageId) return;
    setExporting(true);
    setNotice(null);
    try {
      const [pkg, brief, preferences, designHtml] = await Promise.all([
        api.artifactContent(tenantId, packageId).then((result) => result.content),
        api.deckBrief(projectId, role).then(
          (loaded) => ({ theme: loaded.theme, failed: false }),
          () => ({ theme: null, failed: true }),
        ),
        api.deckDesigns().then(
          (loaded) => loaded as Record<string, unknown>,
          () => ({}) as Record<string, unknown>,
        ),
        designRef ? api.artifactContent(tenantId, designRef).then((result) => (isHtmlDocument(result.content) ? result.content : null), () => null) : Promise.resolve(null),
      ]);
      const built = await buildPackageDeck({
        projectTitle,
        audience: variant ?? node.title,
        role,
        markdown: pkg,
        design: deckDesignFor(role, preferences),
        ...(brief.theme ? { theme: brief.theme } : {}),
        ...(designHtml ? { mockup: { html: designHtml } } : {}),
      });
      await api.persistAudienceDeck(projectId, { variant: variant ?? node.title, title: node.title, dataUri: built.dataUrl, sourceVersionIds: [packageId] });
      onRecorded?.();
      setNotice(redrawSummary(variant ?? node.title, brief.failed, built.imagesNotice));
    } catch (cause) {
      toast.error(`Slides could not be redrawn: ${cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  };

  const exportMenu = node ? (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" loading={exporting} doing="Exporting slides">
          {exporting ? "Exporting slides…" : "Export slides"}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => void exportSlides("google")}>Open in Google Slides</MenuItem>
        <MenuItem onSelect={() => void exportSlides("pptx")}>Save as PPTX</MenuItem>
        <MenuItem onSelect={() => void exportSlides("pdf")}>Save as PDF</MenuItem>
        <MenuItem disabled={!packageId} onSelect={() => void redraw()}>
          Redraw with the current design
        </MenuItem>
      </MenuContent>
    </Menu>
  ) : null;

  return { deck: current.deck, note: current.note, exportMenu, notice };
}

/** What the redraw says when it has recorded the slides (#760). */
export function redrawSummary(audience: string, themeFailed: boolean, imagesNotice: string | null): string {
  const parts = [`Slides for ${audience} were redrawn with the current design and recorded as the newest version; Save as PPTX and Open in Google Slides now hand out this file.`];
  if (themeFailed) parts.push("The design documents could not be read, so this is the role's saved look without their theme.");
  if (imagesNotice) parts.push(`${imagesNotice[0]!.toUpperCase()}${imagesNotice.slice(1)}.`);
  return parts.join(" ");
}
