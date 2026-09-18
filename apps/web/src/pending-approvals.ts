/**
 * Stage 9's delivery decision, read from the stock hub approval it parks on
 * (CL-8566) — `GET /api/tenants/:t/approvals` and `POST .../approve|reject`,
 * not a workflow signal the way every other stage's gate is. Modeled on
 * workbench's `pending-approvals.ts`, trimmed to what this app needs: it has
 * no chat surface of its own, so there is no per-agent filtering here, only
 * "is stage 9's delivery waiting on this project's run."
 */
import type { Transport } from "@intx/hub-client";
import { createHubTransport } from "./hub.ts";

export type PendingApproval = {
  readonly id: string;
  readonly anchorRunId: string;
  readonly runId: string;
  readonly status: "pending" | "approved" | "rejected" | "timeout" | "expired";
  readonly toolDefinition: { readonly name?: string };
  readonly toolArguments: Record<string, unknown>;
  readonly createdAt: string;
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
  const page = await transport.fetch<ApprovalsPage>("GET", approvalsPath(tenantId));
  return page.data;
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

/** Approves the pending delivery: the tool call resolves, the specialist's step ends. Stage 9 is delivered. */
export async function approveDelivery(
  tenantId: string,
  approvalId: string,
  transport: Transport = createHubTransport(),
): Promise<void> {
  await transport.fetch("POST", `${approvalsPath(tenantId)}/${approvalId}/approve`, { scope: "once" });
}

/** Rejects the pending delivery, optionally with a message: the specialist sees it and calls deliver again. */
export async function rejectDelivery(
  tenantId: string,
  approvalId: string,
  message: string,
  transport: Transport = createHubTransport(),
): Promise<void> {
  await transport.fetch("POST", `${approvalsPath(tenantId)}/${approvalId}/reject`, message ? { message } : {});
}
