/**
 * The decision queue, folded in the browser.
 *
 * CL-8612 contract v6: there is no lifecycle run to park a gate/freeze/
 * evidence step on any more, so the only decision a project can wait on is
 * stage 9's delivery — a stock hub approval on the specialist's own
 * `deliver` tool call (CL-8566), read straight off `pending-approvals.ts`.
 * `GET /decisions` is gone (CL-8510); this is what `api.decisions` read
 * from it.
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, resolveWorkspace } from "@solutions-builder/installer";
import { CONSEQUENCE, requiredAuthorityFor } from "@solutions-builder/app/decision-copy";
import type { Wait } from "./client.ts";
import { notifyDecisionOpen } from "./decision-notify.ts";
import { createHubTransport } from "./hub.ts";
import { DELIVER_TOOL_NAME, pendingApprovals } from "./pending-approvals.ts";

const DELIVERY_STAGE = 9;

/** The decision waiting on one project, or null when the next move is not a person's. */
export async function openDecisionFor(
  projectId: string,
  transport: Transport = createHubTransport(),
): Promise<Omit<Wait, "projectTitle"> | null> {
  // `pendingApprovals` is already scoped to this project's own tenant, so
  // any pending `deliver` call in it is stage 9's delivery gate — no
  // anchorRunId to match against any more (CL-8612 contract v6).
  const approvals = await pendingApprovals(projectId, transport);
  const delivery = approvals.find((approval) => approval.status === "pending" && approval.toolDefinition?.name === DELIVER_TOOL_NAME) ?? null;
  if (!delivery) return null;
  const decision = {
    id: `${delivery.id}:${DELIVERY_STAGE}:approval`,
    projectId,
    runId: delivery.runId,
    stage: DELIVERY_STAGE,
    title: "Delivery awaits a decision",
    consequence: CONSEQUENCE[DELIVERY_STAGE] ?? "A human decision is required to continue.",
    blockers: null,
    requiredAuthority: requiredAuthorityFor(DELIVERY_STAGE),
    approvalId: delivery.id,
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
      const decision = await openDecisionFor(record.id, transport);
      return decision ? { ...decision, projectTitle: record.title } : null;
    }),
  );
  return decisions.filter((entry): entry is Wait => entry !== null);
}
