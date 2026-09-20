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
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, listSpecialistDeployments, resolveWorkspace } from "@solutions-builder/installer";
import { CONSEQUENCE, requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import type { Wait } from "./client.ts";
import { notifyDecisionOpen } from "./decision-notify.ts";
import { createHubTransport } from "./hub.ts";
import { DELIVER_TOOL_NAME, pendingApprovals, type PendingApproval } from "./pending-approvals.ts";

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
  const decisions = approvals
    .filter((approval) => approval.status === "pending" && stageByRunId.has(approval.anchorRunId))
    .map((approval) => toDecision(approval, projectId, stageByRunId.get(approval.anchorRunId)!));
  for (const decision of decisions) void notifyDecisionOpen(workspaceTenantId, decision, transport);
  return decisions;
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

/** Every open decision across the workspace's projects, oldest first — the queue. */
export async function openDecisions(transport: Transport = createHubTransport()): Promise<Wait[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = await listProjectRecords(transport, workspace.tenantId);
  const decisions = await Promise.all(
    records.map(async (record) => {
      const found = await openDecisionsFor(workspace.tenantId, record.id, transport);
      return found.map((decision) => ({ ...decision, projectTitle: record.title || record.id }));
    }),
  );
  return decisions.flat();
}
