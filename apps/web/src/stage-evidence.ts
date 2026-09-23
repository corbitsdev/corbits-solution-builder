/**
 * CL-8690/CL-8691: the project workflow never reads an artifact, so a stage
 * 7 `approve` decision carries the evidence its stage rule needs and the
 * reducer validates it (`project-workflow/contracts.ts`'s `stageRules`).
 * This module builds that evidence client-side; `approveStage`
 * (`stage-approval.ts`) just forwards whatever it is given.
 *
 * Stage 5 is different (CL-8870): its rule reads `ProjectState`'s own
 * captured `audiencePolicy`/`audienceDecisions` -- the policy rides on the
 * `open_review` that opens a stage-5 review (`stage-approval.ts`'s
 * `policy`), and each stakeholder's vote is its own `audience` decision.
 * Nothing here builds evidence for it any more.
 */
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import type { Stage7Evidence } from "@solutions-builder/app/project-workflow/contracts";
import { parseStackRecord, type StackRecord } from "@solutions-builder/app/stack";

const STAGE_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  evidence_missing: "The recorded decisions don't match what this approval expects.",
  quorum_not_met: "The stakeholder quorum has not been met yet.",
  target_missing: "Choose a target before approving.",
  frozen_already: "This build is already frozen.",
  requirements_already_minted: "The requirement ids are already set for this project.",
  stack_missing: "The plan's stack decision is missing.",
  stack_uncited: "Every part of the stack must cite the requirement that forces it.",
  stack_unknown_requirement: "The stack cites a requirement id that does not exist.",
};

/** A stage rule's refusal code, in plain language; anything not in the map
 *  (a structural refusal like `stale_review`) is shown as-is. */
export function stageRefusalMessage(reason: string): string {
  return STAGE_REFUSAL_MESSAGES[reason] ?? reason;
}

export type StageEvidenceDeps = {
  readonly projectId: string;
  readonly tenantId: string;
  readonly nodes: readonly ArtifactNode[];
  readonly chosenTarget: string | null;
  readonly workflowView: ProjectWorkflowView | null;
  /** Reads the approved stage-6 build plan's text, to pull its `## Stack`
   *  block out for stage 7's evidence. */
  readonly artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
};

/** Every earlier stage (1..6) the view shows approved, frozen as a reference
 *  to exactly the review the workflow itself holds -- never re-derived from
 *  an artifact's content -- plus the stack the Architect's approved plan
 *  recorded, read straight off that plan's own text. */
async function stage7Evidence(deps: StageEvidenceDeps): Promise<Stage7Evidence | undefined> {
  if (!deps.chosenTarget || !deps.workflowView) return undefined;
  const frozen = Object.entries(deps.workflowView.reviews)
    .filter(([stage, review]) => review?.status === "approved" && Number(stage) <= 6)
    .map(([stage, review]) => ({
      stage: Number(stage),
      artifactId: review!.artifactId,
      version: review!.version,
      sha256: review!.sha256,
    }));
  const stage6Review = deps.workflowView.reviews[6];
  const planNode =
    stage6Review && stage6Review.status === "approved"
      ? deps.nodes.find((node) => node.artifactId === stage6Review.artifactId && node.version === stage6Review.version)
      : undefined;
  const planText = planNode ? (await deps.artifactContent(deps.tenantId, planNode.id)).content : "";
  const stack = parseStackRecord(planText) ?? ({} as StackRecord);
  return { target: deps.chosenTarget, frozen, stack };
}

/** Builds the `approve` decision's evidence for a stage, or `undefined` for
 *  a stage with no evidence to carry (every stage but 7 -- stage 5's rule
 *  reads `ProjectState` directly, CL-8870). */
export async function stageEvidence(stage: number, deps: StageEvidenceDeps): Promise<Stage7Evidence | undefined> {
  if (stage === 7) return stage7Evidence(deps);
  return undefined;
}

/** A short "Frozen for this build" line for stage 8's opening mail, so the
 *  build specialist sees the target and every frozen reference without
 *  re-deriving them from the plan. Takes only the two fields it renders, so
 *  a caller reading `workflowView.freeze` back (no `stack` needed here)
 *  does not have to carry the rest of `Stage7Evidence` just to call it. */
export function frozenSummaryLine(evidence: Pick<Stage7Evidence, "target" | "frozen">): string {
  const refs = [...evidence.frozen].sort((a, b) => a.stage - b.stage).map((ref) => `stage ${String(ref.stage)} v${String(ref.version)}`);
  return `Frozen for this build: target ${evidence.target}; ${refs.join(", ")}.`;
}
