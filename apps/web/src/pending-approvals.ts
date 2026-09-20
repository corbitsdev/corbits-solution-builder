/**
 * Any specialist's pending tool call, read from the stock hub approval it
 * parks on (CL-8566) — `GET /api/tenants/:t/approvals` and
 * `POST .../approve|reject`, not a workflow signal the way every other
 * stage's gate is. Modeled on workbench's `pending-approvals.ts`, trimmed to
 * what this app needs: it has no chat surface of its own, so there is no
 * per-agent filtering here. Specialists (stage 9's `deliver` and any other
 * stage's tool, e.g. stage 8's `run_shell`) deploy into the WORKSPACE
 * tenant, so callers must pass that tenant's id, not a project's.
 */
import { listWorkflowDeployments, type Transport } from "@intx/hub-client";
import { createHubTransport } from "./hub.ts";

export type PendingApproval = {
  readonly id: string;
  readonly anchorRunId: string;
  readonly runId: string;
  readonly status: "pending" | "approved" | "rejected" | "timeout" | "expired";
  readonly toolDefinition: { readonly name?: string };
  readonly toolArguments: Record<string, unknown>;
  readonly createdAt: string;
  readonly resolvedAt?: string | null;
};

type ApprovalsPage = { readonly data: readonly PendingApproval[] };

export function approvalsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/approvals`;
}

/** Every pending approval in the tenant, newest first, as the hub lists them. */
export async function pendingApprovals(
  tenantId: string,
  transport: Transport = createHubTransport(),
): Promise<readonly PendingApproval[]> {
  const [page, deployments] = await Promise.all([
    transport.fetch<ApprovalsPage>("GET", approvalsPath(tenantId)),
    listWorkflowDeployments(transport, tenantId),
  ]);
  return actionableApprovals(page.data, deployments);
}

/** Recovery/provisioning can still accept durable resolutions; release cannot.
 * Match the anchor identity used by the native approval resolution handler,
 * not a nested tool run's identity. Unknown deployments are not actionable.
 */
export function actionableApprovals(
  approvals: readonly PendingApproval[],
  deployments: readonly { readonly id: string; readonly status: string }[],
): readonly PendingApproval[] {
  const active = new Set(deployments
    .filter((deployment) => ["deployed", "pending", "recovering"].includes(deployment.status))
    .map((deployment) => deployment.id));
  return approvals.filter((approval) => approval.status === "pending" && active.has(approval.anchorRunId));
}

/** The tool name the stage-9 specialist's delivery tool is declared under. */
export const DELIVER_TOOL_NAME = "deliver";

/** Stage 9's own pending delivery approval among a run's approvals, or null. */
export function deliveryApprovalFor(
  approvals: readonly PendingApproval[],
  anchorRunId: string,
): PendingApproval | null {
  return (
    approvals.find(
      (approval) =>
        approval.anchorRunId === anchorRunId &&
        approval.status === "pending" &&
        approval.toolDefinition?.name === DELIVER_TOOL_NAME,
    ) ?? null
  );
}

/** One approval by id, pending or resolved — the detail route has no status filter, so a terminal approval (e.g. an accepted delivery) is still readable for its `resolvedAt`. */
export async function approvalById(
  tenantId: string,
  approvalId: string,
  transport: Transport = createHubTransport(),
): Promise<PendingApproval> {
  return transport.fetch<PendingApproval>("GET", `${approvalsPath(tenantId)}/${approvalId}`);
}

/** Approves the pending tool call: it resolves and the specialist's run continues. */
export async function approveTool(
  tenantId: string,
  approvalId: string,
  transport: Transport = createHubTransport(),
): Promise<void> {
  await transport.fetch("POST", `${approvalsPath(tenantId)}/${approvalId}/approve`, { scope: "once" });
}

/** Rejects the pending tool call, optionally with a message: the specialist sees it and can retry. */
export async function rejectTool(
  tenantId: string,
  approvalId: string,
  message: string,
  transport: Transport = createHubTransport(),
): Promise<void> {
  await transport.fetch("POST", `${approvalsPath(tenantId)}/${approvalId}/reject`, message ? { message } : {});
}
