/**
 * CL-8687: a project created before the process authority cutover carries
 * its approval history on the legacy `sb.approvedAt` stamp
 * (`ArtifactNode.approvedAt`, `currentStageFromArtifacts`), not in the
 * project workflow. `adoptionPlan` is the pure read that turns that history
 * into the `open_review`/`approve` decisions replaying it into the workflow
 * one time, so an existing project's process authority starts where its
 * artifacts already say it is rather than back at stage 1.
 *
 * Only runs when the workflow itself has recorded nothing yet (still at its
 * first stage with no decisions) -- once a single real decision exists the
 * workflow is the authority and adoption never runs again for this project.
 */
import { STAGE_DRAFT_KIND } from "./client.ts";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import { digestOf } from "./stage-approval.ts";

export type AdoptionDecision = {
  readonly stage: number;
  readonly artifactId: string;
  readonly version: number;
  readonly content: string;
};

/**
 * The legacy-approved stages, in order, that still need replaying: the
 * longest prefix 1..N of stages with a live, approved draft artifact for
 * that stage's kind, provided the workflow view is untouched (its first
 * stage, no decisions yet). Stops at the first stage with no approved
 * artifact, or once it reaches the last stage-order entry.
 */
export function adoptionPlan(nodes: readonly ArtifactNode[], view: ProjectWorkflowView, stageOrder: readonly number[]): readonly AdoptionDecision[] {
  if (view.decisions.length > 0 || view.stage !== stageOrder[0]) return [];

  const plan: AdoptionDecision[] = [];
  for (const stage of stageOrder) {
    const kind = STAGE_DRAFT_KIND[stage];
    if (!kind) break;
    const approved = nodes
      .filter((node) => node.stage === stage && node.kind === kind && node.supersededByNodeId === null && node.approvedAt !== null)
      .sort((a, b) => b.version - a.version)[0];
    if (!approved) break;
    plan.push({ stage, artifactId: approved.artifactId, version: approved.version, content: "" });
  }
  return plan;
}

export type AdoptionDeps = {
  readonly view: (projectId: string) => Promise<ProjectWorkflowView | null>;
  readonly artifactContent: (nodeId: string) => Promise<{ content: string }>;
  readonly decide: (projectId: string, decision: Record<string, unknown>) => Promise<{ ok: true }>;
  readonly now: () => string;
};

async function adoptionDecisionId(projectId: string, stage: number, kind: "open_review" | "approve"): Promise<string> {
  const bytes = new TextEncoder().encode(`adopt|${projectId}|${String(stage)}|${kind}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `dec-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Runs once per project open, idempotently (deterministic decision ids: a
 * repeat is a no-op accepted-duplicate on every already-applied stage). No
 * effect when `adoptionPlan` finds nothing to replay -- the common case for
 * every project created after the cutover.
 */
export async function adoptExistingProject(deps: AdoptionDeps, projectId: string, nodes: readonly ArtifactNode[], stageOrder: readonly number[]): Promise<void> {
  const view = await deps.view(projectId);
  if (!view) return;
  const plan = adoptionPlan(nodes, view, stageOrder);
  for (const step of plan) {
    const { content } = await deps.artifactContent(step.artifactId);
    const sha256 = await digestOf(content);
    const openId = await adoptionDecisionId(projectId, step.stage, "open_review");
    await deps.decide(projectId, {
      kind: "open_review",
      decisionId: openId,
      projectId,
      stage: step.stage,
      artifactId: step.artifactId,
      version: step.version,
      sha256,
      at: deps.now(),
    });
    const opened = await deps.view(projectId);
    const reviewId = opened?.openReview?.reviewId;
    if (!reviewId) continue;
    const approveId = await adoptionDecisionId(projectId, step.stage, "approve");
    await deps.decide(projectId, {
      kind: "approve",
      decisionId: approveId,
      projectId,
      stage: step.stage,
      reviewId,
      artifactId: step.artifactId,
      version: step.version,
      sha256,
      at: deps.now(),
    });
  }
}
