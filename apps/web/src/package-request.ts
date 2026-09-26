/**
 * What a stakeholder's package specialist is asked, with what it needs to
 * answer (#115). Each stakeholder's package is written by a deployment of
 * its own that never received the stage's opening, so the request itself
 * carries the approved design the packages are built on. Without it a
 * specialist can only ask for the design to be pasted.
 */
export function packageRequest(name: string, design: string | null): string {
  const ask = `Write the package for: ${name}.`;
  if (!design || !design.trim()) return ask;
  return `${ask}\n\nThe approved GUI design this package is built on, for reference:\n\n${design}`;
}
