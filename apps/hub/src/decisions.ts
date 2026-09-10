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
import { database } from "./db.js";
import * as table from "./schema.js";
import { requiredAuthorityFor } from "./engine-approvals.js";
import { rehydrateRun } from "./engine.js";
import { listProjectRecords } from "./project-tenant.js";
import { activeRunRecord, type StoredRun } from "./hub-executor.js";

export type Decision = {
  /** Stable for as long as this run sits in this state. */
  id: string;
  projectId: string;
  projectTitle?: string;
  runId: string;
  stage: Stage;
  title: string;
  consequence: string;
  requiredAuthority: string;
  /** The exact versions the decision would freeze. */
  versions: { artifactId: string; versionId: string; contentHash: string }[];
  notifiedAt: string | null;
  notifyError: string | null;
  createdAt: string;
};

/** Run states in which the next move is a person's. */
const DECIDING_STATES = new Set(["waiting_approval", "cost_approved", "waiting_human", "delivery_review"]);

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

const STATE_CONSEQUENCE: Record<string, string> = {
  cost_approved: "Freezing locks this exact plan and cost and queues the build. Nothing is spent until then.",
  waiting_human: "Answering resumes the same build attempt with exactly what you grant, and nothing more.",
};

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

export function decisionIdFor(run: Pick<StoredRun, "id" | "state">): string {
  return `${run.id}:${run.state}`;
}

/** The decision waiting on this project, or null when the next move is not a person's. */
export async function openDecisionFor(
  projectId: string,
  current?: StoredRun | null,
): Promise<Decision | null> {
  const run = current ?? activeRunRecord(projectId) ?? (await rehydrateRun(projectId)) ?? null;
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
  return {
    id,
    projectId,
    runId: run.id,
    stage: run.stage,
    title: `${STAGE_TITLES[run.stage]} awaits a decision`,
    consequence:
      STATE_CONSEQUENCE[run.state] ?? CONSEQUENCE[run.stage] ?? "A human decision is required to continue.",
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
