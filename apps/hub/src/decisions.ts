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
import { database } from "./db.js";
import * as table from "./schema.js";
import { requiredAuthorityFor } from "./command-approvals.js";
import { listProjectRecords } from "./project-records.js";
import { activeRun, type RunRecord } from "./runs.js";

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
  notifiedAt: string | null;
  notifyError: string | null;
  createdAt: string;
};

/** Run states in which the next move is a person's. */
const DECIDING_STATES = new Set(["waiting_approval", "cost_approved", "waiting_human", "delivery_review"]);

/**
 * Whether a decision has been announced, per process. Notifying is a ping, not
 * a record; after a restart an outstanding decision is still in the queue and
 * may be announced again, which is the honest behaviour.
 */
const announced = new Map<string, { at: Date | null; error: string | null }>();

export function recordAnnouncement(decisionId: string, outcome: { at: Date | null; error: string | null }) {
  announced.set(decisionId, outcome);
}

export function announcementFor(decisionId: string) {
  return announced.get(decisionId);
}

export function decisionIdFor(run: Pick<RunRecord, "id" | "state">): string {
  return `${run.id}:${run.state}`;
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
  const said = announced.get(id);
  const since = nodes[0]?.createdAt ?? run.createdAt;
  // Delivery verification (what blocks a stage 9 accept) is the
  // tools-delivery workflow step's job now, not the host's — see CL-8340.
  const blockers = null;
  return {
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
    notifiedAt: said?.at?.toISOString() ?? null,
    notifyError: said?.error ?? null,
    createdAt: since.toISOString(),
  };
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
