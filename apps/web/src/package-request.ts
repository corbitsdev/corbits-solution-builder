/**
 * What the stage 5 specialist is asked for a stakeholder's package, with
 * what it needs to answer. The request itself names the audience, by name
 * and role (#41 step 3): the one presentation-creator deployment serves
 * every stakeholder, its prompt names none of them, and a stakeholder
 * added or renamed after the stage opened is asked for as named now, with
 * no redeploy. It also carries the approved design the packages are built
 * on (#115): the specialist's opening turn may be pages back, or on an
 * earlier deployment's thread after a redeploy, and without the design here
 * it can only ask for it to be pasted. And it carries the deck's brief
 * (#246): the design guidelines that apply to this project, since the
 * specialist's prompt is fixed at deploy and the mail is the only place a
 * project's own instruction can reach it. The look is the interface's to
 * apply when it draws the slides (#285), so none of it rides here.
 */
import { packageOutlineProblem } from "@solutions-builder/app/deck";
import type { DeckBrief } from "./deck-design-documents.ts";
import { designHandoff } from "./design-handoff.ts";

export type PackageAudience = { readonly name: string; readonly role: string };

/** The person working the project, addressed as "you" wherever the app speaks to them. */
export function isOwner(audience: { readonly role: string }): boolean {
  return audience.role === "project_owner";
}

/** The audience's package as a sentence names it. */
export function packageOf(audience: PackageAudience): string {
  return isOwner(audience) ? "your package" : `${audience.name}'s package`;
}

/** The first sentence of the request for the audience's package. */
function packageAsk(audience: PackageAudience): string {
  return isOwner(audience)
    ? "Write the package for the project owner, the person you are talking with: address them as you, under `## Audience: you`"
    : `Write the package for: ${audience.name}, the ${roleLabel(audience.role)}`;
}

/** A role id as a person (or a model) reads it: `budget_approver` → "budget approver". */
function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * Why a reply to `packageAsk(audience)` is not the audience's package, or null when it
 * is one (#220). The presentation creator's prompt says a package without a
 * deck outline is refused and nothing is recorded; the page holds the reply
 * to that before recording it, since an acknowledgement, a question or a
 * claim that a deck was rendered is not a package, and recording one left a
 * stakeholder with a "package" no slides could be built from.
 */
export function packageReplyProblem(audience: PackageAudience, body: string): string | null {
  const problem = packageOutlineProblem(body);
  return problem ? `${isOwner(audience) ? "Your package" : `${audience.name}'s package`} was not written: the reply ${problem}. Ask for it again.` : null;
}

/**
 * The one follow-up sent when a reply to `packageAsk(audience)` was not a
 * package (#225): what was missing and where the package has to be.
 */
export function packageNudge(audience: PackageAudience, problem: string): string {
  return `${packageAsk(audience)} — again, as the reply itself.\n\nYour last reply was not the package: ${problem}. Reply with the package: the status line, then the five headed sections in Markdown, with the deck outline as numbered slides, in this reply. Markdown handed to render_deck is not read as the package.`;
}

export function packageRequest(audience: PackageAudience, design: string | null, brief: DeckBrief | null = null): string {
  const parts = [`${packageAsk(audience)}.`];
  // An HTML mockup goes over as its text, not its markup (#219): mailed
  // verbatim, the model answered with HTML instead of a Markdown package.
  if (design && design.trim()) parts.push(`The approved GUI design this package is built on, for reference:\n\n${designHandoff(design)}`);
  if (brief?.guidelines) parts.push(brief.guidelines);
  return parts.join("\n\n");
}
