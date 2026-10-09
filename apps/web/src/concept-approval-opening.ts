/**
 * What Concept approval opens with (#722): the approved GUI design, led by
 * what the stage is opening with and that no package is asked for yet. The
 * Presentation creator's prompt expects every request to name a reader, so
 * an opening that was only the design read as a request for a package, and
 * its first reply announced one it never wrote. Composed in one place for
 * the in-session hand-off (`use-stage-decisions.ts`) and the reload path
 * (`use-opening-dispatch.ts`), so the two never drift.
 */
import { designHandoff } from "./design-handoff.ts";
import type { PackageRoster } from "./package-request.ts";

/** A role id as a person reads it: `budget_approver` → "budget approver". */
function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/** The lead's line naming who is on record, so the specialist confirms names rather than inventing them. */
export function rosterOnRecordLine(roster: PackageRoster): string {
  if (roster.audiences.length === 0) return "No stakeholders are on record yet.";
  const everyone = roster.audiences.map((entry) => `${entry.name} (${roleLabel(entry.role)})`).join(", ");
  const needed = roster.quorum > 0 ? `${String(roster.quorum)} of them must proceed` : "each decides for themselves";
  return `On record so far: ${everyone}; ${needed}.`;
}

/** The lead, before the design: what this is, who is on record, and that the first job is the roster, not a package. */
export function conceptApprovalLead(roster: PackageRoster): string {
  return [
    "Concept approval is opening on the approved GUI design below.",
    rosterOnRecordLine(roster),
    "No package is requested yet: the first job is to find out who needs to approve to move forward. Packages come after, each asked for by name.",
  ].join(" ");
}

/** The opening message: the lead, then the design as its text (#219). */
export function conceptApprovalOpening(design: string, roster: PackageRoster): string {
  return `${conceptApprovalLead(roster)}\n\n${designHandoff(design)}`;
}
