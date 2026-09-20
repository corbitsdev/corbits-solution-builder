/**
 * The decision queue, folded in the browser.
 *
 * CL-8612 contract v6: there is no lifecycle run to park a gate/freeze/
 * evidence step on any more, so what a project can wait on is a stock hub
 * approval on one of its stage specialists' own tool calls (CL-8566) —
 * stage 9's `deliver`, or any other stage's tool (e.g. stage 8's
 * `run_shell`) — read straight off `pending-approvals.ts`. Specialists
 * deploy into the WORKSPACE tenant (`ensureSpecialistDeployment`), not the
 * project's own tenant, so approvals are read from there and matched back to
 * a project/stage via `listSpecialistDeployments`. `GET /decisions` is gone
 * (CL-8510); this is what `api.decisions` read from it.
 *
 * CL-8724: a hub tool approval is not the only thing a person's move can be
 * waiting on. The project workflow (`project-workflow.ts`) is its own
 * process authority, independent of any parked tool call, so its own open
 * review or an unreviewed specialist draft at the project's CURRENT stage is
 * folded in here too, as a second kind of `Wait` (no `approvalId`).
 */
import type { Transport } from "@intx/hub-client";
import type { Stage } from "@solutions-builder/app/ledger";
import {
  listProjectRecords,
  listSpecialistDeployments,
  resolveWorkspace,
  stageSpecialistStatus,
} from "@solutions-builder/installer";
import { CONSEQUENCE, requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import type { Wait } from "./client.ts";
import { notifyDecisionOpen } from "./decision-notify.ts";
import { createHubTransport } from "./hub.ts";
import { DELIVER_TOOL_NAME, pendingApprovals, type PendingApproval } from "./pending-approvals.ts";
import { loadProjectWorkflowView, type ProjectWorkflowView } from "./project-workflow.ts";
import { resolveProjectWorkflowRef } from "./project-workflow-ref.ts";
import { readStageThread } from "./stage-mail.ts";
import { latestSubstantialDraft } from "./pages/workspace/guidance.ts";

/** What the exact command/arguments a non-delivery tool call carries, shown so the person sees exactly what they'd be approving. */
function toolCommand(approval: PendingApproval): string {
  const command = approval.toolArguments?.["command"];
  return typeof command === "string" ? command : JSON.stringify(approval.toolArguments ?? {});
}

function toDecision(approval: PendingApproval, projectId: string, stage: number): Omit<Wait, "projectTitle"> {
  const isDelivery = approval.toolDefinition?.name === DELIVER_TOOL_NAME;
  return {
    id: `${approval.id}:${stage}:approval`,
    projectId,
    runId: approval.runId,
    stage,
    title: isDelivery ? "Delivery awaits a decision" : `Stage ${stage} specialist asks to run a tool`,
    consequence: isDelivery
      ? (CONSEQUENCE[stage] ?? "A human decision is required to continue.")
      : `Runs \`${approval.toolDefinition?.name ?? "a tool"}\`: ${toolCommand(approval)}`,
    blockers: null,
    requiredAuthority: requiredAuthorityFor(stage),
    approvalId: approval.id,
    ...(approval.toolDefinition?.name ? { toolName: approval.toolDefinition.name } : {}),
  };
}

/** Every decision waiting on one project: a pending approval on a run that
 *  belongs to one of its stage specialist deployments. */
async function openDecisionsFor(
  workspaceTenantId: string,
  projectId: string,
  transport: Transport,
): Promise<Omit<Wait, "projectTitle">[]> {
  const [approvals, deployments] = await Promise.all([
    pendingApprovals(workspaceTenantId, transport),
    listSpecialistDeployments(transport, workspaceTenantId, projectId),
  ]);
  const stageByRunId = new Map(deployments.map((deployment) => [deployment.deploymentId, deployment.stage]));
  return approvals
    .filter((approval) => approval.status === "pending" && stageByRunId.has(approval.anchorRunId))
    .map((approval) => toDecision(approval, projectId, stageByRunId.get(approval.anchorRunId)!));
}

/**
 * Pure: whether the project workflow's current stage is a person's move, and
 * what to show for it. Never for a converged (`done`) workflow. Approvable
 * two ways — an open review at this stage, or (with no open review yet) a
 * substantial specialist draft sitting in the stage thread — but only the
 * former carries `reviewRef`, since only an exact open review is safe to
 * approve directly from the queue (CL-8724).
 */
export function stageApprovalDecision(
  projectId: string,
  runId: string,
  view: ProjectWorkflowView,
  hasSubstantialDraft: boolean,
): Omit<Wait, "projectTitle"> | null {
  if (view.done) return null;
  const review = view.openReview;
  if (!review && !hasSubstantialDraft) return null;
  const stage = view.stage;
  return {
    id: `${projectId}:${String(stage)}:stage-approval`,
    projectId,
    runId,
    stage,
    title: `Stage ${stage} is waiting on a decision`,
    consequence: CONSEQUENCE[stage] ?? "A human decision is required to continue.",
    blockers: null,
    requiredAuthority: requiredAuthorityFor(stage),
    ...(review ? { reviewRef: { artifactId: review.artifactId, version: review.version, sha256: review.sha256 } } : {}),
  };
}

const STAGE_APPROVAL_CACHE_TTL_MS = 20_000;
const stageApprovalCache = new Map<string, { value: Omit<Wait, "projectTitle"> | null; expiresAt: number }>();

/**
 * The project workflow's current-stage wait for one project, read-only and
 * cached ~20s per project — this reads the workflow's own event log plus,
 * when there is no open review yet, the stage thread, so it is bounded to
 * one project/stage per call, never every stage of every project.
 */
async function stageApprovalWaitFor(
  workspaceTenantId: string,
  projectId: string,
  transport: Transport,
): Promise<Omit<Wait, "projectTitle"> | null> {
  const cached = stageApprovalCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await (async (): Promise<Omit<Wait, "projectTitle"> | null> => {
    const ref = await resolveProjectWorkflowRef(transport, workspaceTenantId, projectId);
    if (!ref) return null;
    const view = await loadProjectWorkflowView(transport, workspaceTenantId, ref);
    if (view.done) return null;
    if (view.openReview) return stageApprovalDecision(projectId, ref.runId, view, false);

    const status = await stageSpecialistStatus(transport, workspaceTenantId, projectId, view.stage as Stage);
    if (!status) return null;
    const messages = await readStageThread(workspaceTenantId, [status.address]);
    const hasSubstantialDraft = latestSubstantialDraft(messages) !== null;
    return stageApprovalDecision(projectId, ref.runId, view, hasSubstantialDraft);
  })();

  stageApprovalCache.set(projectId, { value, expiresAt: Date.now() + STAGE_APPROVAL_CACHE_TTL_MS });
  return value;
}

/** The decision waiting on one project, or null when the next move is not a person's. */
export async function openDecisionFor(
  projectId: string,
  transport: Transport = createHubTransport(),
): Promise<Omit<Wait, "projectTitle"> | null> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return null;
  const decisions = await openDecisionsFor(workspace.tenantId, projectId, transport);
  return decisions[0] ?? null;
}

/** Notifies once per decision and folds the outcome onto it, so the queue can
 *  render "Sent"/"Not sent yet"/"Delivery failed" without a second read. */
async function withNotifyOutcome(
  workspaceTenantId: string,
  decision: Omit<Wait, "projectTitle">,
  transport: Transport,
): Promise<Omit<Wait, "projectTitle">> {
  const outcome = await notifyDecisionOpen(workspaceTenantId, decision, transport);
  return { ...decision, ...outcome };
}

/** Every open decision across the workspace's projects, oldest first — the
 *  queue. Archived projects never contribute a wait of either kind. */
export async function openDecisions(transport: Transport = createHubTransport()): Promise<Wait[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = (await listProjectRecords(transport, workspace.tenantId)).filter((record) => record.archivedAt === null);
  const decisions = await Promise.all(
    records.map(async (record) => {
      const [toolWaits, stageWait] = await Promise.all([
        openDecisionsFor(workspace.tenantId, record.id, transport),
        stageApprovalWaitFor(workspace.tenantId, record.id, transport),
      ]);
      const found = stageWait ? [...toolWaits, stageWait] : toolWaits;
      const withOutcomes = await Promise.all(
        found.map((decision) => withNotifyOutcome(workspace.tenantId, decision, transport)),
      );
      return withOutcomes.map((decision) => ({ ...decision, projectTitle: record.title || record.id }));
    }),
  );
  return decisions.flat();
}
