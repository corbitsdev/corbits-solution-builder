/**
 * The open decision on a project, derived rather than stored.
 *
 * A run parked at a gate is the record that someone's decision is awaited;
 * what the decision is called, what it freezes and who may take it all follow
 * from the ledger given the run's state and stage. The `human_wait` table that
 * used to copy this out at each gate is gone: a row that restates a
 * derivation is one more thing to keep in step.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Stage } from "@solutions-builder/app/ledger";
import { STAGE_TITLES } from "@solutions-builder/app/ledger";
import { CONSEQUENCE, STATE_CONSEQUENCE } from "@solutions-builder/app/decision-copy";
import { approveSignal, evidenceSignal } from "@solutions-builder/app/workflows/stage-loop";
import { database } from "./db.js";
import * as table from "./schema.js";
import { requiredAuthorityFor } from "./command-approvals.js";
import { listProjectRecords } from "./project-records.js";
import { activeRun, type RunRecord } from "./runs.js";
import { hub, hubIsMounted } from "./hub-mount.js";
import { tenantId } from "./hub-client.js";

export type Decision = {
  /** Stable for as long as this run sits in this state. */
  id: string;
  projectId: string;
  projectTitle?: string;
  runId: string;
  stage: Stage;
  title: string;
  consequence: string;
  /** Why the decision cannot be taken yet, or null when it can. */
  blockers: string | null;
  requiredAuthority: string;
  /** The exact versions the decision would freeze. */
  versions: { artifactId: string; versionId: string; contentHash: string }[];
  createdAt: string;
};

/** Run states in which the next move is a person's. */
const DECIDING_STATES = new Set(["waiting_approval", "cost_approved", "waiting_human", "delivery_review"]);

export function decisionIdFor(run: Pick<RunRecord, "id" | "state">): string {
  return `${run.id}:${run.state}`;
}

/** The `signal:<name>` gate a decision in this state parks on. */
function gateSignalFor(run: Pick<RunRecord, "stage" | "state">): string {
  return run.state === "waiting_human" ? evidenceSignal(run.stage) : approveSignal(run.stage);
}

/**
 * Files one @corbits/mailbox inbox item per principal holding the gate's
 * `signal:<name>` grant. Idempotent: `deliverInboxItems` dedupes on
 * `(source, externalId)`, so calling this again for the same parked decision
 * (every poll finds it still open) delivers nothing new. Best-effort — a
 * mailbox failure never blocks the decision queue from rendering.
 */
async function notifyDecisionOpen(run: Pick<RunRecord, "stage" | "state">, decision: Decision): Promise<void> {
  if (!hubIsMounted()) return;
  try {
    await hub().notifyGrantHolders({
      tenantId: tenantId(),
      resource: "workflow-run:*",
      action: `signal:${gateSignalFor(run)}`,
      source: "solutions-builder.decision",
      externalId: decision.id,
      subject: decision.title,
      body: decision.consequence,
    });
  } catch (cause) {
    console.error(`decision notify failed for ${decision.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The decision waiting on this project, or null when the next move is not a person's. */
export async function openDecisionFor(
  projectId: string,
  current?: RunRecord | null,
): Promise<Decision | null> {
  const run = current ?? (await activeRun(projectId));
  if (!run || !DECIDING_STATES.has(run.state)) return null;

  const { db } = database();
  const nodes = await db
    .select({
      artifactId: table.artifactNode.artifactId,
      id: table.artifactNode.id,
      contentHash: table.artifactNode.contentHash,
      createdAt: table.artifactNode.createdAt,
    })
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, projectId),
        eq(table.artifactNode.stage, run.stage),
        isNull(table.artifactNode.supersededByNodeId),
      ),
    )
    .orderBy(desc(table.artifactNode.createdAt));

  const id = decisionIdFor(run);
  const since = nodes[0]?.createdAt ?? run.createdAt;
  // Delivery verification (what blocks a stage 9 accept) is the
  // tools-delivery workflow step's job now, not the host's — see CL-8340.
  const blockers = null;
  const decision: Decision = {
    blockers,
    id,
    projectId,
    runId: run.id,
    stage: run.stage,
    title: `${STAGE_TITLES[run.stage]} awaits a decision`,
    consequence:
      blockers ?? STATE_CONSEQUENCE[run.state] ?? CONSEQUENCE[run.stage] ?? "A human decision is required to continue.",
    requiredAuthority: requiredAuthorityFor(run.stage),
    versions: nodes.map((node) => ({
      artifactId: node.artifactId,
      versionId: node.id,
      contentHash: node.contentHash,
    })),
    createdAt: since.toISOString(),
  };
  void notifyDecisionOpen(run, decision);
  return decision;
}

/** Every open decision across projects, oldest first — the queue. */
export async function openDecisions(): Promise<Decision[]> {
  const projects = await listProjectRecords();
  const decisions: Decision[] = [];
  for (const project of projects) {
    const decision = await openDecisionFor(project.id);
    if (decision) decisions.push({ ...decision, projectTitle: project.title });
  }
  return decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
