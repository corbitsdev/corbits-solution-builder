/**
 * Replaying an adoption plan (`legacy-adoption.ts`'s `adoptionPlan`) on a
 * project's running workflow, one stage at a time, so the workflow's own
 * reducer lands the stage and its ledger shows every decision. Shared by
 * `scripts/adopt-legacy-projects.ts` (a project made on `main` in this
 * workspace) and `legacy-import.ts` (a project brought in from a `main`
 * export), which differ only in how the workflow is reached: the `deps`
 * here are the same `view`/`decide` pair the stage pages use.
 *
 * Each stage is replayed the way the person would have done it: stage 5's
 * votes first, stage 6's requirements minted first, then the review opened
 * on the version the old ledger approved and approved. The replay stops at
 * the first refusal and says why, leaving the workflow wherever it got to.
 */
import type { AdoptionPlan } from "@solutions-builder/app/legacy-adoption";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import { approveStage, ensureReviewOpen, mintRequirements, type StageApprovalDeps } from "./stage-approval.ts";

export type AdoptionOutcome = {
  /** The stage the workflow reports after the replay, or null when it never reported one. */
  readonly landed: number | null;
  /** Why the replay stopped short, or null when every step landed. */
  readonly stopped: string | null;
};

export type ReplayOptions = {
  /** How long to wait for the workflow to report a stage at all. */
  readonly startTimeoutMs?: number;
  /** How long to wait for stage 5's votes to land. */
  readonly votesTimeoutMs?: number;
  readonly pollIntervalMs?: number;
};

const START_TIMEOUT_MS = 120_000;
const VOTES_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

async function pollView(
  view: () => Promise<ProjectWorkflowView | null>,
  until: (view: ProjectWorkflowView) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<ProjectWorkflowView | null> {
  const deadline = Date.now() + timeoutMs;
  let latest: ProjectWorkflowView | null = null;
  for (;;) {
    latest = await view().catch(() => null);
    if (latest && until(latest)) return latest;
    if (Date.now() >= deadline) return latest;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A stakeholder's name as a decision id fragment. */
export const audienceSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The decision id a replayed stage 5 vote carries: one per project and stakeholder, so a second replay is a no-op. */
export function replayedVoteDecisionId(projectId: string, audience: string): string {
  return `adopt-${projectId}-5-audience-${audienceSlug(audience)}`;
}

/**
 * Lands `plan` on its project's workflow. A step the workflow is already
 * past is skipped (an earlier replay, or the person); a step ahead of the
 * workflow stops the replay, since the stage between was never approved.
 */
export async function replayAdoption(deps: StageApprovalDeps, plan: AdoptionPlan, options: ReplayOptions = {}): Promise<AdoptionOutcome> {
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const view = () => deps.view(plan.projectId);
  let current = await pollView(view, (candidate) => candidate.stage >= 1, options.startTimeoutMs ?? START_TIMEOUT_MS, interval);
  if (!current || current.stage < 1) return { landed: null, stopped: "the project's workflow never reported a stage" };

  for (const step of plan.steps) {
    if (current.stage > step.stage) continue;
    if (current.stage < step.stage) return { landed: current.stage, stopped: `the workflow is at stage ${String(current.stage)}, not ${String(step.stage)}` };

    if (step.stage === 5 && step.votes) {
      for (const [audience, vote] of Object.entries(step.votes)) {
        await deps.decide(plan.projectId, {
          kind: "audience",
          decisionId: replayedVoteDecisionId(plan.projectId, audience),
          projectId: plan.projectId,
          stage: 5,
          audience,
          decision: vote.decision,
          ...(vote.note ? { note: vote.note } : {}),
          at: deps.now(),
        });
      }
      const wanted = Object.keys(step.votes);
      const voted = await pollView(view, (candidate) => wanted.every((name) => name in candidate.audienceDecisions), options.votesTimeoutMs ?? VOTES_TIMEOUT_MS, interval);
      if (!voted || !wanted.every((name) => name in voted.audienceDecisions)) return { landed: current.stage, stopped: "the stakeholders' votes did not land" };
    }
    if (step.stage === 6 && step.requirementItems && step.requirementItems.length > 0) {
      const minted = await mintRequirements(deps, { projectId: plan.projectId, stage: 6, items: step.requirementItems });
      if (!minted.ok) return { landed: current.stage, stopped: `minting the requirements was refused: ${minted.reason}` };
    }
    const opened = await ensureReviewOpen(deps, { projectId: plan.projectId, stage: step.stage, ref: step.ref, ...(step.policy ? { policy: step.policy } : {}) });
    if (!opened.ok) return { landed: current.stage, stopped: `opening stage ${String(step.stage)}'s review was refused: ${opened.reason}` };
    const approved = await approveStage(deps, { projectId: plan.projectId, stage: step.stage, ref: step.ref, ...(step.policy ? { policy: step.policy } : {}) });
    if (!approved.ok) return { landed: current.stage, stopped: `approving stage ${String(step.stage)} was refused: ${approved.reason}` };
    current = (await view()) ?? current;
  }
  return { landed: current.stage, stopped: null };
}
