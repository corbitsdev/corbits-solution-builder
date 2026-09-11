/**
 * Seeds Solutions Builder's workflow definitions into the hub.
 *
 * Build plan §9: "Seed idempotent versioned project-lifecycle, stage, approval,
 * design-feedback, provider-switch, build-supervision and delivery workflows
 * using native Interchange facilities. Reconciliation creates missing
 * definitions; explicit migrations upgrade them while preserving running
 * instances, user choices, approvals and history."
 *
 * Idempotent by construction: the definition is keyed on its own wire hash, so
 * re-running seeds nothing when the generated definition has not changed, and
 * creates a new version when it has. A running instance keeps the version it
 * started on.
 */
import { registerDefinition } from "./hub-gaps.js";
import { sha256 } from "./ids.js";
import { tenantId } from "./hub-client.js";
import type { WorkflowDefinition } from "@intx/workflow";
import { STAGES } from "@solutions-builder/app/ledger";
import type { RequiredGrant } from "@solutions-builder/app/kit";
import { grantRequirementsFor } from "@solutions-builder/app/seed-kit";
import { projectLifecycleDefinition, PROJECT_LIFECYCLE_ID } from "@solutions-builder/app/workflows/project-lifecycle";
import { stageDefinition, STAGE_WORKFLOW_ID } from "@solutions-builder/app/workflows/stage-loop";
import {
  APPROVAL_WORKFLOW_ID,
  approvalDefinition,
  BUILD_SUPERVISION_WORKFLOW_ID,
  buildSupervisionDefinition,
  DELIVERY_WORKFLOW_ID,
  deliveryDefinition,
  DESIGN_FEEDBACK_WORKFLOW_ID,
  designFeedbackDefinition,
  PROVIDER_SWITCH_WORKFLOW_ID,
  providerSwitchDefinition,
} from "@solutions-builder/app/workflows/concerns";

export type SeededWorkflow = {
  readonly id: string;
  readonly name: string;
  readonly wireHash: string;
  readonly created: boolean;
};

/** Every definition §9 names, each generated from the ledger. */
function definitions(): { name: string; description: string; definition: WorkflowDefinition; grantRequirements?: RequiredGrant[] }[] {
  return [
    {
      name: PROJECT_LIFECYCLE_ID,
      description:
        "The nine human-gated stages, generated from the Solutions Builder transition ledger.",
      definition: projectLifecycleDefinition(),
    },
    ...STAGES.map((stage) => ({
      name: `${STAGE_WORKFLOW_ID}.${stage}`,
      description: `Stage ${stage}: draft, revise against what the person says, and stop at the gate.`,
      definition: stageDefinition(stage),
      grantRequirements: grantRequirementsFor(stage),
    })),
    {
      name: APPROVAL_WORKFLOW_ID,
      description: "What a reviewer may do with a submitted stage.",
      definition: approvalDefinition(),
    },
    {
      name: DESIGN_FEEDBACK_WORKFLOW_ID,
      description: "Stage 4: anchored feedback, then a new design version drafted from it.",
      definition: designFeedbackDefinition(),
    },
    {
      name: PROVIDER_SWITCH_WORKFLOW_ID,
      description: "Regenerating an artifact from approved input under a different binding.",
      definition: providerSwitchDefinition(),
    },
    {
      name: BUILD_SUPERVISION_WORKFLOW_ID,
      description: "Stage 8: a build that outlives the window, and the humans it must ask.",
      definition: buildSupervisionDefinition(),
    },
    {
      name: DELIVERY_WORKFLOW_ID,
      description: "Stage 9: accept the manifest, or send it back with a route.",
      definition: deliveryDefinition(),
    },
  ];
}

/**
 * What the package would deploy right now, without deploying it. Identity is
 * the wire hash, so comparing these ids against the tenant's rows says whether
 * the installed definitions are current, missing or stale.
 */
export async function expectedWorkflowDefinitions(): Promise<{ name: string; id: string }[]> {
  const expected: { name: string; id: string }[] = [];
  for (const entry of definitions()) {
    const wireHash = await sha256(JSON.stringify(entry.definition));
    expected.push({ name: entry.name, id: `wfd_${wireHash.slice(0, 24)}` });
  }
  return expected;
}

export async function seedWorkflows(): Promise<SeededWorkflow[]> {
  const seeded: SeededWorkflow[] = [];
  for (const entry of definitions()) {
    // The wire projection is what identity is keyed on upstream, so the hash is
    // taken over the definition exactly as it would be deployed.
    const wireHash = await sha256(JSON.stringify(entry.definition));
    const written = await registerDefinition(tenantId(), {
      id: `wfd_${wireHash.slice(0, 24)}`,
      name: entry.name,
      description: entry.description,
      wireHash,
      ...(entry.grantRequirements ? { grantRequirements: entry.grantRequirements } : {}),
    });
    seeded.push({ id: written.id, name: entry.name, wireHash, created: written.created });
  }

  return seeded;
}
