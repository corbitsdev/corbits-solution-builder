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
import type { ArtifactNode, Remediation } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";
import type { Stage7Evidence } from "@solutions-builder/app/project-workflow/contracts";
import {
  checkStackCitations,
  parseStackRecord,
  type StackCitationProblem,
  type StackRecord,
} from "@solutions-builder/app/stack";

/** The "stack" is the architect's technical decision -- runtime, storage,
 *  packaging and so on -- recorded as a fenced JSON block under `## Stack`
 *  in the stage 6 build plan. It is not the target the person picks on
 *  stage 7, and the copy never calls it a "stack decision": a person has
 *  only ever seen the build plan and its Stack section. */
const STACK_MISSING_MESSAGE =
  "The approved build plan (stage 6) has no Stack section, so there is nothing to freeze. Send the project back to stage 6 and ask the architect to re-issue the plan with one.";

const STAGE_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  evidence_missing: "The recorded decisions don't match what this approval expects.",
  quorum_not_met: "The stakeholder quorum has not been met yet.",
  target_missing: "Choose a target before approving.",
  frozen_already: "This build is already frozen.",
  requirements_already_minted: "The requirement ids are already set for this project.",
  stack_missing: STACK_MISSING_MESSAGE,
  stack_uncited: "Every part of the build plan's Stack section must cite the requirement that forces it.",
  stack_unknown_requirement: "The build plan's Stack section cites a requirement id that does not exist.",
  not_audience_stage: "Stakeholder decisions are recorded at stage 5 only.",
  unknown_audience: "That stakeholder is not on this project's list for the open review.",
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
/** The approved stage 6 build plan's text, read off exactly the version
 *  the workflow's own review names. `unapproved` when stage 6 holds no
 *  approved review; `unread` when that review names a version this
 *  project's artifact graph does not hold. */
async function approvedPlanText(
  deps: Pick<StageEvidenceDeps, "tenantId" | "nodes" | "workflowView" | "artifactContent">,
): Promise<{ status: "read"; text: string } | { status: "unapproved" } | { status: "unread" }> {
  const stage6Review = deps.workflowView?.reviews[6];
  if (!stage6Review || stage6Review.status !== "approved") return { status: "unapproved" };
  const planNode = deps.nodes.find(
    (node) => node.artifactId === stage6Review.artifactId && node.version === stage6Review.version,
  );
  if (!planNode) return { status: "unread" };
  return { status: "read", text: (await deps.artifactContent(deps.tenantId, planNode.id)).content };
}

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
  const plan = await approvedPlanText(deps);
  const stack = parseStackRecord(plan.status === "read" ? plan.text : "") ?? ({} as StackRecord);
  return { target: deps.chosenTarget, frozen, stack };
}

/** Builds the `approve` decision's evidence for a stage, or `undefined` for
 *  a stage with no evidence to carry (every stage but 7 -- stage 5's rule
 *  reads `ProjectState` directly, CL-8870). */
export async function stageEvidence(stage: number, deps: StageEvidenceDeps): Promise<Stage7Evidence | undefined> {
  if (stage === 7) return stage7Evidence(deps);
  return undefined;
}

/**
 * Stage 6's own gate on the plan being approved: the same checks stage 7's
 * `stack_missing`/`stack_uncited`/`stack_unknown_requirement` refusals apply
 * (`project-workflow/contracts.ts`'s `stage7Rule`), run here so a plan whose
 * `## Stack` block doesn't parse or cite real requirement ids never gets
 * past stage 6 in the first place -- stage 6 is read-only once approved, so
 * catching it here is the only chance. `null` means the plan's stack is
 * fine to approve; anything else is a message for the person to act on,
 * never sent to the workflow.
 */
export function stage6StackProblem(planText: string, requirementIds: ReadonlySet<string>): string | null {
  const stack = parseStackRecord(planText);
  if (!stack) {
    return "The build plan's Stack section is missing or not in the required shape (a fenced JSON block). Ask the architect to resend it before approving.";
  }
  const problems = checkStackCitations(stack, requirementIds);
  if (problems.length === 0) return null;
  return `The build plan's Stack section has uncited or unknown requirement ids (${citationDetail(problems)}). Ask the architect to fix the citations before approving.`;
}

function citationDetail(problems: readonly StackCitationProblem[]): string {
  return problems
    .map((p) =>
      p.problem === "uncited"
        ? `${p.entry} cites no requirement`
        : `${p.entry} cites unknown requirement id(s) ${(p.ids ?? []).join(", ")}`,
    )
    .join("; ");
}

/** What stops a stage 7 approval, and the way out, or null when nothing
 *  does. The workflow's `stage7Rule` remains the authority; this is the
 *  same check run first, so the person reads why and gets the action. */
export type Stage7Problem = { readonly message: string; readonly remediation?: Remediation };

/** A way out of stage 7 for a plan whose Stack section cannot be frozen:
 *  the send-back picker, seeded with the reason, aimed at stage 6. Stage 6
 *  is read-only once approved, so re-issuing the plan is the only fix. */
function sendBackToStage6(reason: string): Remediation {
  return { kind: "send_back", label: "Send back to stage 6…", targetStage: 6, reason };
}

/**
 * Stage 7's own pre-check on the plan it is about to freeze: the checks
 * `stage7Rule`'s `stack_missing`/`stack_uncited`/`stack_unknown_requirement`
 * refusals apply, run before the approval is sent so the person reads what
 * is wrong in the build plan's own terms and is offered the send-back that
 * resolves it. A plan approved before stage 6 gated on its Stack section
 * (CL-8861 and after) reaches here with no section at all; without this
 * the refusal named a "stack decision" the person had never seen and
 * offered nothing.
 */
export async function stage7StackProblem(deps: StageEvidenceDeps): Promise<Stage7Problem | null> {
  const plan = await approvedPlanText(deps);
  // No approved stage 6 review: the workflow's own evidence check answers that, not this.
  if (plan.status === "unapproved") return null;
  if (plan.status === "unread") {
    return {
      message:
        "The approved build plan could not be read from this project's artifacts, so its Stack section could not be checked. Reload and try again.",
    };
  }
  const stack = parseStackRecord(plan.text);
  if (!stack) {
    return {
      message: STACK_MISSING_MESSAGE,
      remediation: sendBackToStage6("The approved build plan has no Stack section. Please re-issue it with one."),
    };
  }
  const requirementIds = new Set((deps.workflowView?.requirements ?? []).map((r) => r.id));
  const problems = checkStackCitations(stack, requirementIds);
  if (problems.length === 0) return null;
  const detail = citationDetail(problems);
  return {
    message: `The approved build plan's Stack section has uncited or unknown requirement ids (${detail}), so it cannot be frozen. Send the project back to stage 6 and ask the architect to fix the citations.`,
    remediation: sendBackToStage6(`The build plan's Stack section has citation problems: ${detail}. Please fix them.`),
  };
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
