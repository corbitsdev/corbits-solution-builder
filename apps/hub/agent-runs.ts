/**
 * Recording what an agent invocation was — BUILD_PLAN_V3 §8.
 *
 * Written on the same transaction boundary as the draft it describes: a run
 * record for an artifact that was never persisted would be a claim about work
 * nobody can see, and an artifact with no run record cannot be judged after
 * the fact.
 */
import { database } from "./db.js";
import * as table from "./schema.js";
import { newId } from "./ids.js";

export type AgentRunInput = {
  projectId: string;
  branchId: string;
  runId: string;
  stage: number;
  agentId: string;
  promptKey: string;
  promptVersion: number;
  modelKey: string;
  providerId: string;
  model: string;
  inputVersionIds: string[];
  producedNodeId: string | null;
  assumptions: string[];
  questions: string[];
  outcome: "drafted" | "failed";
  failure?: string;
};

export async function recordAgentRun(input: AgentRunInput): Promise<string> {
  const { db } = database();
  const id = newId.agentRun();
  await db.insert(table.agentRunRecord).values({
    id,
    projectId: input.projectId,
    branchId: input.branchId,
    runId: input.runId,
    stage: input.stage,
    agentId: input.agentId,
    promptKey: input.promptKey,
    promptVersion: input.promptVersion,
    modelKey: input.modelKey,
    providerId: input.providerId,
    model: input.model,
    inputVersionIds: input.inputVersionIds,
    producedNodeId: input.producedNodeId,
    assumptions: input.assumptions,
    questions: input.questions,
    outcome: input.outcome,
    failure: input.failure ?? null,
  });
  return id;
}
