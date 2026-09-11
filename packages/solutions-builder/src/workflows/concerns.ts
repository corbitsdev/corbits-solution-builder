/**
 * Names for the concerns §9 lists beside the lifecycle: approval,
 * design-feedback, provider-switch, build-supervision and delivery.
 *
 * These were once definitions generated from the ledger and seeded as their
 * own workflow rows. They are not deployed or registered anywhere now — the
 * per-project lifecycle deployment is the one run that exists — but the kit
 * (`seed-kit.ts`) still groups agents and skills under a director by these
 * names, so the ids stay as the vocabulary a director's `workflows` list is
 * written in.
 */
export const APPROVAL_WORKFLOW_ID = "solutions-builder.approval";
export const DESIGN_FEEDBACK_WORKFLOW_ID = "solutions-builder.design-feedback";
export const PROVIDER_SWITCH_WORKFLOW_ID = "solutions-builder.provider-switch";
export const BUILD_SUPERVISION_WORKFLOW_ID = "solutions-builder.build-supervision";
export const DELIVERY_WORKFLOW_ID = "solutions-builder.delivery";
