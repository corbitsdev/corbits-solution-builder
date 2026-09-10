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
import { STAGES, type Stage } from "@solutions-builder/app/ledger";
import type { RequiredGrant } from "@solutions-builder/app/kit";
import { baseTemplate } from "@solutions-builder/app/template";
import { kitSeed } from "@solutions-builder/app/seed-kit";
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
/**
 * The grants a stage's agent needs, as Interchange's own requirement manifest.
 *
 * §8's read/propose/write split is expressed here rather than in a Builder
 * table, because this is what the hub resolves at launch into materialized
 * grants — a grant recorded anywhere else is a description of an authority
 * rather than the authority itself.
 *
 * `source: "invoker"` throughout: an agent acts on the authority of whoever
 * launched the run, and is satisfied only if that person actually holds the
 * capability. That is what stops a definition granting itself something its
 * author could not.
 */
function grantsForStage(stage: Stage): RequiredGrant[] {
  const seed = kitSeed();
  const slotAgent = baseTemplate().slots.find((binding) =>
    STAGE_SLOTS[stage]?.includes(binding.slot),
  )?.agent;
  const agent = seed.agents.find((entry) => entry.agent === slotAgent);
  if (!agent) return [];

  return agent.toolKeys.flatMap((toolKey) => {
    const tool = seed.tools.find((entry) => entry.key === toolKey);
    const grant = seed.grants.find((entry) => entry.key === tool?.grantKey);
    if (!tool || !grant) return [];
    return [
      {
        resource: grant.capability,
        action: tool.mode,
        // A capability whose exercise needs a human decision is asked for,
        // never assumed — §8's "no agent gets human approval authority".
        effect: grant.requiresApproval ? ("ask" as const) : ("allow" as const),
        source: "invoker" as const,
      },
    ];
  });
}

/** Which slot fills which stage, for reading the agent off the template. */
const STAGE_SLOTS: Partial<Record<Stage, string[]>> = {
  1: ["discovery-interviewer"],
  2: ["constraint-mapper"],
  3: ["proposal-strategy"],
  4: ["surface-design", "design-feedback"],
  5: ["audience-package"],
  6: ["plan-and-review"],
  7: ["estimate-and-policy"],
  8: ["build-execution"],
  9: ["target-verification", "delivery-manifest"],
};

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
      grantRequirements: grantsForStage(stage),
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
