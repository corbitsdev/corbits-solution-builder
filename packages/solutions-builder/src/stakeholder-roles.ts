/**
 * The stakeholder roster as the Presentation creator is asked for it (#722),
 * re-exported from the specialist's package the way `stack.ts` re-exports
 * the Architect's `STACK_BLOCK_SHAPE`: the interface imports from this
 * package, never from a specialist's. The role ids are written out in the
 * specialist's package, since it cannot import the ledger; the test beside
 * this file holds them to `AUTHORITIES` less "system", the list
 * `STAKEHOLDER_ROLES` in the interface's client is built from.
 */
export { STAKEHOLDER_ROLE_IDS, STAKEHOLDERS_BLOCK_SHAPE, type StakeholderRoleId } from "@solutions-builder/specialist-presentation-creator";
