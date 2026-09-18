/**
 * Host plumbing for the stage conversation.
 *
 * The fold itself — turning a stage's iterations, its artifact nodes and the
 * stage-1 opening statement into turns — is pure and lives in
 * `@solutions-builder/app/stage-thread`, so the web client can run the
 * identical rule over the same `/hub` events. This module only supplies what
 * the fold cannot get on its own: the iterations' events and blob refs (over
 * `lifecycle-run.ts`), and the DB-backed nodes, opening command and carried
 * turns a still-running host process needs for its own purposes —
 * `agent-conversation.ts`'s draft-prompt context and `api-stages.ts`'s
 * `/reply` interview-mode decision, until those move to run signals.
 */
import {
  evaluationIn as foldEvaluation,
  failedRoundBody,
  nextOpenQuestion,
  projectStageThread,
  type ArtifactNodeRef,
  type OutputResolver,
} from "@solutions-builder/app/stage-thread";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";
import type { Stage } from "@solutions-builder/app/ledger";
import { readOutputRef, stageIterations, type StageIteration } from "./lifecycle-run.js";
import { database } from "./db.js";
import * as table from "./schema.js";
import { eq } from "drizzle-orm";
import { carriedTurns, ledgerCommands } from "./command-ledger.js";

export type { Quote, StageTurn, ArtifactNodeRef };
export { nextOpenQuestion, failedRoundBody };

const readRef: OutputResolver = (anchor, runId, ref) => readOutputRef(anchor, runId, ref);

/** The opening problem statement, projected as stage 1's first human turn — read once, off the `project.create` command. */
async function openingFor(
  projectId: string,
  stage: number,
): Promise<{ body: string; createdAt: string } | null> {
  if (stage !== 1) return null;
  const commands = await ledgerCommands(projectId);
  const opened = commands.find((command) => command.command === "project.create");
  if (!opened || !opened.message) return null;
  return { body: opened.message, createdAt: opened.createdAt };
}

/**
 * The stage thread, assembled: every iteration's turns, the project's live
 * artifact nodes (for `resultNodeId`) and, at stage 1, the opening problem
 * statement. The shape a route or `questions.ts` reads.
 */
export async function threadTurns(projectId: string, stage: number): Promise<StageTurn[]> {
  const { db } = database();
  const [iterations, nodes, opening, carried] = await Promise.all([
    stageIterations(projectId, stage as Stage),
    db
      .select({ id: table.artifactNode.id, provenance: table.artifactNode.provenance })
      .from(table.artifactNode)
      .where(eq(table.artifactNode.projectId, projectId)),
    openingFor(projectId, stage),
    carriedTurns(projectId, stage),
  ]);
  const here = await projectStageThread({ iterations, nodes: nodes as ArtifactNodeRef[], opening, readRef });
  if (carried.length === 0) return here;
  // What was carried in happened before anything that ran here; the opening
  // statement, when there is one, came before all of it.
  const [first, ...rest] = here;
  const before = first?.id === "opening" ? [first] : [];
  const after = first?.id === "opening" ? rest : here;
  return [...before, ...(carried as StageTurn[]), ...after];
}

/** The stage's conversation as it can travel: every turn that ran here or was carried here, the opening statement aside since it rides on the ledger. */
export async function portableThread(projectId: string, stage: number): Promise<StageTurn[]> {
  return (await threadTurns(projectId, stage)).filter((turn) => turn.id !== "opening");
}

/** The latest brief-evaluator verdict for the stage, or null before one has run. */
export async function evaluationIn(
  iterations: readonly StageIteration[],
): Promise<{ ready: boolean; notes: string[] } | null> {
  return foldEvaluation(iterations, readRef);
}
