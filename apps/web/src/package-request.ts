/**
 * What the stage 5 specialist is asked for a stakeholder's package, with
 * what it needs to answer. The request itself names the audience, by name
 * and role (#41 step 3): the one presentation-creator deployment serves
 * every stakeholder, its prompt names none of them, and a stakeholder
 * added or renamed after the stage opened is asked for as named now, with
 * no redeploy. It also carries the approved design the packages are built
 * on (#115): the specialist's opening turn may be pages back, or on an
 * earlier deployment's thread after a redeploy, and without the design here
 * it can only ask for it to be pasted.
 */
import { packageOutlineProblem } from "@solutions-builder/app/deck";
import { designHandoff } from "./design-handoff.ts";

export type PackageAudience = { readonly name: string; readonly role: string };

/** The first line of the request for `name`'s package: what the specialist
 *  is told to write, and what `packageReplyFor` finds the request by. */
export function packageAsk(name: string): string {
  return `Write the package for: ${name}`;
}

/** A role id as a person (or a model) reads it: `budget_approver` → "budget approver". */
function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * Why a reply to `packageAsk(name)` is not `name`'s package, or null when it
 * is one (#220). The presentation creator's prompt says a package without a
 * deck outline is refused and nothing is recorded; the page holds the reply
 * to that before recording it, since an acknowledgement, a question or a
 * claim that a deck was rendered is not a package, and recording one left a
 * stakeholder with a "package" no slides could be built from.
 */
export function packageReplyProblem(name: string, body: string): string | null {
  const problem = packageOutlineProblem(body);
  return problem ? `${name}'s package was not written: the reply ${problem}. Ask for it again.` : null;
}

/**
 * The one follow-up sent when a reply to `packageAsk(name)` was not a
 * package (#225): what was missing and where the package has to be. Opens
 * with the same ask line, so the reply to it is found the same way.
 */
export function packageNudge(audience: PackageAudience, problem: string): string {
  return `${packageAsk(audience.name)}, the ${roleLabel(audience.role)} — again, as the reply itself.\n\nYour last reply was not the package: ${problem}. Reply with the package: the status line, then the five headed sections in Markdown, with the deck outline as numbered slides, in this reply. Markdown handed to render_deck is not read as the package.`;
}

export function packageRequest(audience: PackageAudience, design: string | null): string {
  const ask = `${packageAsk(audience.name)}, the ${roleLabel(audience.role)}.`;
  if (!design || !design.trim()) return ask;
  // An HTML mockup goes over as its text, not its markup (#219): mailed
  // verbatim, the model answered with HTML instead of a Markdown package.
  return `${ask}\n\nThe approved GUI design this package is built on, for reference:\n\n${designHandoff(design)}`;
}
