/**
 * The open decision on a project, derived rather than stored.
 *
 * A run parked at a gate is the record that someone's decision is awaited:
 * folded straight from the run's own committed `/hub` events
 * (`@solutions-builder/app/project-state`), the same fold the client applies,
 * rather than from the ledger's own `RunRecord`. What the decision is called
 * and what it freezes follow from the stage the parked step names.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Stage } from "@solutions-builder/app/ledger";
import { STAGE_TITLES } from "@solutions-builder/app/ledger";
import { CONSEQUENCE, STATE_CONSEQUENCE } from "@solutions-builder/app/decision-copy";
import { EVIDENCE_STEP_ID, FREEZE_STEP_ID, approveSignal, evidenceSignal, exhaustedStepId, gateStepId } from "@solutions-builder/app/workflows/stage-loop";
import { foldRun, openQuestion, parkedSteps, type FoldedRun } from "@solutions-builder/app/project-state";
import { database } from "./db.js";
import * as table from "./schema.js";
import { requiredAuthorityFor } from "./command-approvals.js";
import { listProjectRecords } from "./project-records.js";
import { currentAnchor } from "./lifecycle-run.js";
import { deploymentRuns } from "./hub-client.js";
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

/** One run parked on a person's decision, and which kind of park it is. */
type ParkedDecision = { runId: string; stage: Stage; kind: "gate" | "freeze" | "evidence" | "question" };

/** The run parked on a person's move, if any — a gate, a freeze, an evidence hand-off, or an unanswered question. */
function parkedDecision(runs: readonly FoldedRun[]): ParkedDecision | null {
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

export function decisionIdFor(park: ParkedDecision): string {
  return `${park.runId}:${park.stage}:${park.kind}`;
}

/** The `signal:<name>` gate a decision of this kind parks on. */
function gateSignalFor(park: ParkedDecision): string {
  return park.kind === "evidence" || park.kind === "question" ? evidenceSignal(park.stage) : approveSignal(park.stage);
}

/**
 * Files one @corbits/mailbox inbox item per principal holding the gate's
 * `signal:<name>` grant. Idempotent: `deliverInboxItems` dedupes on
 * `(source, externalId)`, so calling this again for the same parked decision
 * (every poll finds it still open) delivers nothing new. Best-effort — a
 * mailbox failure never blocks the decision queue from rendering.
 */
async function notifyDecisionOpen(park: ParkedDecision, decision: Decision): Promise<void> {
  if (!hubIsMounted()) return;
  try {
    await hub().notifyGrantHolders({
      tenantId: tenantId(),
      resource: "workflow-run:*",
      action: `signal:${gateSignalFor(park)}`,
      source: "solutions-builder.decision",
      externalId: decision.id,
      subject: decision.title,
      body: decision.consequence,
    });
  } catch (cause) {
    console.error(`decision notify failed for ${decision.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The consequence copy for a parked decision: the state-keyed one when there is one, else the stage's. */
function consequenceFor(park: ParkedDecision): string {
  const fallback = CONSEQUENCE[park.stage] ?? "A human decision is required to continue.";
  if (park.kind === "freeze") return STATE_CONSEQUENCE.cost_approved ?? fallback;
  if (park.kind === "question") return STATE_CONSEQUENCE.waiting_human ?? fallback;
  return fallback;
}

/** Every run under the project's deployment, folded from its committed `/hub` events. */
export async function foldedRunsFor(projectId: string): Promise<FoldedRun[]> {
  const anchor = await currentAnchor(projectId);
  if (!anchor) return [];
  const runIds = await deploymentRuns.list(anchor);
  const folded: FoldedRun[] = [];
  for (const runId of runIds) {
    folded.push(foldRun(runId, await deploymentRuns.events(anchor, runId)));
  }
  return folded;
}

/** The decision waiting on this project, or null when the next move is not a person's. */
export async function openDecisionFor(projectId: string, runs?: readonly FoldedRun[]): Promise<Decision | null> {
  const folded = runs ?? (await foldedRunsFor(projectId));
  const park = parkedDecision(folded);
  if (!park) return null;

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
        eq(table.artifactNode.stage, park.stage),
        isNull(table.artifactNode.supersededByNodeId),
      ),
    )
    .orderBy(desc(table.artifactNode.createdAt));

  const id = decisionIdFor(park);
  const since = nodes[0]?.createdAt ?? new Date();
  // Delivery verification (what blocks a stage 9 accept) is the
  // tools-delivery workflow step's job now, not the host's — see CL-8340.
  const blockers = null;
  const decision: Decision = {
    blockers,
    id,
    projectId,
    runId: park.runId,
    stage: park.stage,
    title: `${STAGE_TITLES[park.stage]} awaits a decision`,
    consequence: blockers ?? consequenceFor(park),
    requiredAuthority: requiredAuthorityFor(park.stage),
    versions: nodes.map((node) => ({
      artifactId: node.artifactId,
      versionId: node.id,
      contentHash: node.contentHash,
    })),
    createdAt: since.toISOString(),
  };
  void notifyDecisionOpen(park, decision);
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
