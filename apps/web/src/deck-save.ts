/**
 * Building a stakeholder's slides in the browser when no deck artifact was
 * recorded beside their package. Pure: given the package markdown, it
 * returns the finished PowerPoint as a `data:` URL, ready for
 * `downloadArtifact` — the same shape an already-recorded deck's content
 * comes back as.
 *
 * When the role's design asks for images and an `imageCredential` is
 * supplied, slides are illustrated: `deck-images.ts`'s `artDirection` picks
 * which slides get a picture and `illustration` draws each one, ported from
 * main's `apps/hub/src/deck-images.ts`. No credential is ever read back from
 * the hub here (it cannot be -- see `deck-images.ts`), so a caller that
 * cannot supply one still gets a deck, just without pictures; the setting is
 * never silently ignored, but nothing here fails the build over it.
 */
import { deckFileName, deckFrom, packageOutlineProblem, renderDeck, DECK_MEDIA_TYPE, DECK_THEMES, type DeckDesign, type TemplateTheme } from "@solutions-builder/app/deck";
import { toBase64 } from "./base64.ts";
import { artDirection, illustration, illustrationPrompt, type ImageCredential } from "./deck-images.ts";

export async function buildPackageDeck(args: {
  projectTitle: string;
  audience: string;
  role: string;
  markdown: string;
  /** The role's saved look and content choices; the plain default when absent. */
  design?: DeckDesign;
  /** The role's style guide theme, when one is mapped and readable. Wins over `design`'s colour and typeface. */
  theme?: TemplateTheme;
  /** A connected image provider's credential, for this build only; never stored. Absent means no pictures, whatever the design's images policy asks for. */
  imageCredential?: ImageCredential;
}): Promise<{ dataUrl: string; filename: string; imagesNotice: string | null }> {
  const problem = packageOutlineProblem(args.markdown);
  if (problem) {
    throw new Error(`Can't build slides for ${args.audience}: ${problem}`);
  }
  const deck = deckFrom(args);
  if (!deck) {
    throw new Error(`Can't build slides for ${args.audience}: its outline has no slides.`);
  }
  const policy = deck.design.images;
  let images: Map<string, Uint8Array> | undefined;
  let imagesNotice: string | null = null;
  if (policy !== "none" && args.imageCredential) {
    try {
      const direction = await artDirection({
        credential: args.imageCredential,
        mode: policy,
        projectTitle: deck.projectTitle,
        audience: deck.audience,
        role: deck.role,
        guidance: deck.design.guidance,
        slides: deck.slides,
        decision: deck.decision,
      });
      images = new Map();
      for (const [key, subject] of direction) {
        const prompt = illustrationPrompt({ subject, colour: DECK_THEMES[deck.design.theme].accent });
        images.set(key, await illustration(args.imageCredential, prompt));
      }
    } catch (cause) {
      imagesNotice = `pictures could not be drawn (${cause instanceof Error ? cause.message : String(cause)}); slides built without them`;
    }
  } else if (policy !== "none") {
    imagesNotice = "no connected provider has an image model, so slides were built without pictures";
  }
  const bytes = await renderDeck(images ? { ...deck, images } : deck);
  return {
    dataUrl: `data:${DECK_MEDIA_TYPE};base64,${toBase64(bytes)}`,
    filename: deckFileName(args.projectTitle, args.audience),
    imagesNotice,
  };
}
