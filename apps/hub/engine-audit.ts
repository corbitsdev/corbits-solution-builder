/**
 * Audit and outbox emission, and the durable human wait that rides along
 * with a gate transition. Nothing here decides whether a transition is
 * allowed — the guard already owns that — and nothing here writes run
 * state.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Stage } from "@solutions-builder/app/ledger";
import { STAGE_TITLES } from "@solutions-builder/app/ledger";
import { newId } from "./ids.js";
import * as table from "./schema.js";
import { requiredAuthorityFor } from "./engine-approvals.js";
import type { Tx } from "./engine.js";

export async function audit(
  tx: Tx,
  entry: {
    projectId: string | null;
    actorPrincipalId: string;
    authority: string | null;
    command: string;
    transitionId: string | null;
    correlationId: string;
    before: unknown;
    after: unknown;
    outcome: string;
  },
) {
  await tx.insert(table.auditEvent).values({ id: newId.audit(), ...entry });
}

export async function enqueue(
  tx: Tx,
  topic: string,
  payload: Record<string, unknown>,
  correlationId: string,
) {
  await tx
    .insert(table.outboxEntry)
    .values({ id: newId.outbox(), topic, payload, correlationId });
}

/** What a gate freezes, in the approver's language. Section 10's copy rule. */
const CONSEQUENCE: Record<number, string> = {
  1: "Approving accepts the problem brief and opens solution shape. Revisions stay possible.",
  2: "Approving fixes the solution bounds every later stage is held to.",
  3: "Approving selects this exact proposal and its branch as the execution path.",
  4: "Approving fixes the design every build check is measured against.",
  5: "Approving records that the named audiences agree this is worth pursuing.",
  6: "Approving accepts the plan as complete and buildable, and sends it to costing.",
  7: "Approving the cost authorizes spend against this exact plan, then freezes the build packet.",
  8: "Accepting this evidence ends the build and opens delivery review.",
  9: "Accepting this manifest completes delivery of the exact versions listed.",
};

/**
 * Opens the durable wait for a gate. Committed inside the same transaction as
 * the transition, so a notification that never fires cannot lose the request.
 */
export async function openWait(
  tx: Tx,
  args: {
    projectId: string;
    runId: string;
    stage: Stage;
    versions: unknown;
    correlationId: string;
  },
): Promise<string> {
  const id = newId.wait();
  await tx.insert(table.humanWait).values({
    id,
    projectId: args.projectId,
    runId: args.runId,
    stage: args.stage,
    title: `${STAGE_TITLES[args.stage]} awaits a decision`,
    consequence: CONSEQUENCE[args.stage] ?? "A human decision is required to continue.",
    requiredAuthority: requiredAuthorityFor(args.stage),
    versions: args.versions ?? [],
  });
  await enqueue(tx, "human_wait.opened", { waitId: id, runId: args.runId }, args.correlationId);
  return id;
}

export async function closeWait(tx: Tx, runId: string) {
  await tx
    .update(table.humanWait)
    .set({ resolvedAt: new Date() })
    .where(and(eq(table.humanWait.runId, runId), isNull(table.humanWait.resolvedAt)));
}
