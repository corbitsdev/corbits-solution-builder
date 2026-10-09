/**
 * The stakeholder roster's shape as the Presentation creator is told it
 * (#722), kept beside the prompt that quotes it the way the Architect's
 * `stack-block-shape.ts` sits beside its prompt. The role ids are the
 * ledger's authorities less "system", which a specialist package cannot
 * import (it depends on nothing in the app), so they are written out here
 * and `stakeholder-roles.test.ts` in the app package holds the two lists
 * together. The app's `stakeholders-block.ts` validates a block against
 * this same list, so what is asked for is what is accepted.
 */
export const STAKEHOLDER_ROLE_IDS = ["project_owner", "budget_approver", "technical_approver", "audience_member", "builder_operator", "delivery_recipient"] as const;

export type StakeholderRoleId = (typeof STAKEHOLDER_ROLE_IDS)[number];

export const STAKEHOLDERS_BLOCK_SHAPE = `
{
  "audiences": [{ "name": string, "role": one of ${STAKEHOLDER_ROLE_IDS.map((id) => `"${id}"`).join(" | ")} }, ...],
  "quorum": number (how many of them must proceed; 0 means each decides for themselves)
}
`.trim();
