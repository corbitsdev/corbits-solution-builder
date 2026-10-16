/**
 * Whether the person's own Proceed is all the Concept approval quorum still
 * lacks (#896). When it is, the gate's one button records that Proceed and
 * then approves, the way it always has for a sole stakeholder (#725): a
 * person listed among others was otherwise held by a quorum that only their
 * own missing vote kept open, with nothing above the chat box to click.
 *
 * Read off the workflow's own `stage5Quorum` fold, never re-counted here:
 * the person's vote is absent (`missing`) or on an earlier package
 * (`stale`), nobody has blocked, and one more proceed reaches `required`.
 * A proceed already counted is never recorded twice, and a block is left
 * to the chips: this never overrides a Needs revision or Reject, not even
 * the person's own.
 */
import type { QuorumState } from "@solutions-builder/app/project-workflow/contracts";

export function ownProceedDecides(quorum: QuorumState | null, you: string | null): boolean {
  if (quorum === null || you === null || quorum.met) return false;
  if (quorum.blocked.length > 0) return false;
  if (!quorum.missing.includes(you) && !quorum.stale.includes(you)) return false;
  return quorum.proceeded + 1 >= quorum.required;
}
