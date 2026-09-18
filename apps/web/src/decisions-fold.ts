/**
 * The decision queue, folded in the browser.
 *
 * Same rule as `apps/hub/src/decisions.ts`'s `openDecisions`/`openDecisionFor`,
 * over the same `/hub` events and the same static stage copy — the only
 * host-only part of that file (notifying mailbox grant holders) is not this
 * fold's job. `GET /decisions` is gone (CL-8510); this is what `api.decisions`
 * read from it.
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, resolveWorkspace, workflowsFor } from "@solutions-builder/installer";
import { currentDeployment } from "./project-list.ts";
import { STAGE_TITLES, type Stage } from "@solutions-builder/app/ledger";
import { CONSEQUENCE, STATE_CONSEQUENCE, requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import { DELIVERY_STAGE, EVIDENCE_STEP_ID, FREEZE_STEP_ID, exhaustedStepId, gateStepId } from "@solutions-builder/app/workflows/stage-loop";
import { openQuestion, parkedSteps, type FoldedRun } from "@solutions-builder/app/project-state";
import type { Wait } from "./client.ts";
import { notifyDecisionOpen } from "./decision-notify.ts";
import { createHubTransport } from "./hub.ts";
import { deliveryApprovalFor, pendingApprovals } from "./pending-approvals.ts";
import { foldProjectRuns } from "./run-fold.ts";

type ParkedDecision =
  | { runId: string; stage: Stage; kind: "gate" | "freeze" | "evidence" | "question" }
  | { runId: string; stage: Stage; kind: "approval"; approvalId: string };

function parkedDecision(runs: readonly FoldedRun[]): Omit<ParkedDecision, "kind" | "approvalId"> & { kind: "gate" | "freeze" | "evidence" | "question" } | null {
  for (const parked of parkedSteps(runs)) {
    if (parked.stepId === gateStepId(parked.stage) || parked.stepId === exhaustedStepId(parked.stage)) {
      return { runId: parked.runId, stage: parked.stage, kind: "gate" };
    }
    if (parked.stepId === FREEZE_STEP_ID) return { runId: parked.runId, stage: parked.stage, kind: "freeze" };
    if (parked.stepId === EVIDENCE_STEP_ID) return { runId: parked.runId, stage: parked.stage, kind: "evidence" };
  }
  for (const run of runs) {
    if (openQuestion(runs, run.runId)) return { runId: run.runId, stage: 8, kind: "question" };
  }
  return null;
}

function decisionIdFor(park: ParkedDecision): string {
  return `${park.runId}:${park.stage}:${park.kind}`;
}

function consequenceFor(park: ParkedDecision): string {
  const fallback = CONSEQUENCE[park.stage] ?? "A human decision is required to continue.";
  if (park.kind === "freeze") return STATE_CONSEQUENCE.cost_approved ?? fallback;
  if (park.kind === "question") return STATE_CONSEQUENCE.waiting_human ?? fallback;
  return fallback;
}

/** The decision waiting on one project, or null when the next move is not a person's. */
export async function openDecisionFor(
  projectId: string,
  anchorRunId: string,
  transport: Transport = createHubTransport(),
): Promise<Omit<Wait, "projectTitle"> | null> {
  const runs = await foldProjectRuns(projectId, anchorRunId, transport);
  let park: ParkedDecision | null = parkedDecision(runs);
  // Stage 9's delivery gate is a stock hub approval on the specialist's own
  // `deliver` tool call, not a step the run's own event history parks on the
  // way every other gate does (CL-8566) — read it off the tenant's pending
  // approvals instead.
  if (!park) {
    const approvals = await pendingApprovals(projectId, transport);
    const delivery = deliveryApprovalFor(approvals, anchorRunId);
    if (delivery) park = { runId: delivery.runId, stage: DELIVERY_STAGE, kind: "approval", approvalId: delivery.id };
  }
  if (!park) return null;
  const decision = {
    id: decisionIdFor(park),
    projectId,
    runId: park.runId,
    stage: park.stage,
    title: `${STAGE_TITLES[park.stage]} awaits a decision`,
    consequence: consequenceFor(park),
    blockers: null,
    requiredAuthority: requiredAuthorityFor(park.stage),
    ...(park.kind === "approval" ? { approvalId: park.approvalId } : {}),
  };
  void notifyDecisionOpen(decision, transport);
  return decision;
}

/** Every open decision across the workspace's projects, oldest first — the queue. */
export async function openDecisions(transport: Transport = createHubTransport()): Promise<Wait[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = await listProjectRecords(transport, workspace.tenantId);
  const decisions = await Promise.all(
    records.map(async (record): Promise<Wait | null> => {
      const deployment = currentDeployment(await workflowsFor(transport, record.id).deployments());
      if (!deployment) return null;
      const decision = await openDecisionFor(record.id, deployment.id, transport);
      return decision ? { ...decision, projectTitle: record.title } : null;
    }),
  );
  return decisions.filter((entry): entry is Wait => entry !== null);
}
