/**
 * Building a stakeholder's slides in the browser when no deck artifact was
 * recorded beside their package. Pure: given the package markdown, it
 * returns the finished PowerPoint as a `data:` URL, ready for
 * `downloadArtifact` — the same shape an already-recorded deck's content
 * comes back as.
 */
import { deckFileName, deckFrom, packageOutlineProblem, renderDeck, DECK_MEDIA_TYPE, type TemplateTheme } from "@solutions-builder/app/deck";
import { toBase64 } from "./base64.ts";

export async function buildPackageDeck(args: {
  projectTitle: string;
  audience: string;
  role: string;
  markdown: string;
  /** The role's style guide theme, when one is mapped and readable. */
  theme?: TemplateTheme;
}): Promise<{ dataUrl: string; filename: string }> {
  const problem = packageOutlineProblem(args.markdown);
  if (problem) {
    throw new Error(`Can't build slides for ${args.audience}: ${problem}`);
  }
  const deck = deckFrom(args);
  if (!deck) {
    throw new Error(`Can't build slides for ${args.audience}: its outline has no slides.`);
  }
  const bytes = await renderDeck(deck);
  return {
    dataUrl: `data:${DECK_MEDIA_TYPE};base64,${toBase64(bytes)}`,
    filename: deckFileName(args.projectTitle, args.audience),
  };
}
