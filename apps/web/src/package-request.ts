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

export function packageRequest(audience: PackageAudience, design: string | null): string {
  const ask = `${packageAsk(audience.name)}, the ${roleLabel(audience.role)}.`;
  if (!design || !design.trim()) return ask;
  return `${ask}\n\nThe approved GUI design this package is built on, for reference:\n\n${design}`;
}
