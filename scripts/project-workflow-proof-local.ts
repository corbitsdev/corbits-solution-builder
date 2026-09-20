import "./smoke-env.ts";

import { runLocal, type ActionHandler, type LoopFn } from "@intx/workflow";
import {
  createApplyDecisionAction,
  holdState,
  initProject,
  recordExhausted,
} from "../packages/solutions-builder/src/project-workflow/actions.ts";
import { contentSha256, type ReadArtifact } from "../packages/solutions-builder/src/project-workflow/contracts.ts";
import {
  PROJECT_DECISION_SIGNAL,
  projectWorkflow,
  projectWorkflowLoopCarry,
  projectWorkflowLoopWhile,
} from "../packages/solutions-builder/src/project-workflow/workflow.ts";

const PROJECT_ID = "proof-project";
const OWNER = "owner-principal";

const artifactContent: Record<string, string> = {
  "proof-project-stage-1-artifact@1": "stage 1 brief, version 1",
  "stage-1-review-2-content": "stage 1 brief, revised",
};

// The real artifact for a given (artifactId, version). Stage-1's re-opened
// review after send-back gets a fresh artifactId/version per the reducer's
// deterministic naming; content is keyed the same way here.
const readArtifact: ReadArtifact = async (artifactId, version) => {
  const key = `${artifactId}@${String(version)}`;
  const content = artifactContent[key];
  return content === undefined ? null : { content };
};

const handlers: Record<string, ActionHandler> = {
  initProject,
  holdState,
  applyDecision: createApplyDecisionAction(readArtifact),
  recordExhausted,
};

const loopFns: Record<string, LoopFn> = {
  projectWorkflowLoopWhile,
  projectWorkflowLoopCarry,
};

let signalCount = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  console.log(`PASS ${message}`);
}

const run = runLocal(projectWorkflow, {
  runId: "project_workflow_proof_local",
  triggerPayload: {
    projectId: PROJECT_ID,
    stages: [
      { stage: 1, authorizedPrincipalIds: [OWNER] },
      { stage: 2, authorizedPrincipalIds: [OWNER] },
    ],
    firstReview: { reviewId: "stage-1-review-1", artifactId: `${PROJECT_ID}-stage-1-artifact`, version: 1 },
  },
  authorize: async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null }),
  actionResolver: (ref) => {
    const handler = handlers[ref];
    if (!handler) throw new Error(`unknown project workflow action ${ref}`);
    return handler;
  },
  loopFns: (ref) => {
    const fn = loopFns[ref];
    if (!fn) throw new Error(`unknown project workflow loop fn ${ref}`);
    return fn;
  },
});

async function signal(decision: Record<string, unknown>, principalId: string = OWNER): Promise<void> {
  signalCount += 1;
  await run.signal(
    PROJECT_DECISION_SIGNAL,
    { principalId, decision },
    `sig-${String(signalCount)}`,
  );
}

const stage1ArtifactId = `${PROJECT_ID}-stage-1-artifact`;
const stage1Sha = contentSha256(artifactContent[`${stage1ArtifactId}@1`]!);

// 1. approve(1)
await signal({
  decisionId: "d1-approve-1",
  projectId: PROJECT_ID,
  stage: 1,
  reviewId: "stage-1-review-1",
  artifactId: stage1ArtifactId,
  version: 1,
  sha256: stage1Sha,
  outcome: "approve",
});

const stage2ArtifactId = `${PROJECT_ID}-stage-2-artifact`;
const stage2Content = "placeholder stage 2 content";
artifactContent[`${stage2ArtifactId}@1`] = stage2Content;
const stage2Sha = contentSha256(stage2Content);

// 2. unauthorized
await signal(
  {
    decisionId: "d2-unauthorized",
    projectId: PROJECT_ID,
    stage: 2,
    reviewId: "stage-2-review-1",
    artifactId: stage2ArtifactId,
    version: 1,
    sha256: stage2Sha,
    outcome: "approve",
  },
  "intruder-principal",
);
// 3. stale reviewId
await signal({
  decisionId: "d3-stale-review",
  projectId: PROJECT_ID,
  stage: 2,
  reviewId: "stage-2-review-0-stale",
  artifactId: stage2ArtifactId,
  version: 1,
  sha256: stage2Sha,
  outcome: "approve",
});
// 4. wrong version
await signal({
  decisionId: "d4-wrong-version",
  projectId: PROJECT_ID,
  stage: 2,
  reviewId: "stage-2-review-1",
  artifactId: stage2ArtifactId,
  version: 99,
  sha256: stage2Sha,
  outcome: "approve",
});
// 5. wrong hash
await signal({
  decisionId: "d5-wrong-hash",
  projectId: PROJECT_ID,
  stage: 2,
  reviewId: "stage-2-review-1",
  artifactId: stage2ArtifactId,
  version: 1,
  sha256: "0".repeat(64),
  outcome: "approve",
});
// 6. wrong project
await signal({
  decisionId: "d6-wrong-project",
  projectId: "not-this-project",
  stage: 2,
  reviewId: "stage-2-review-1",
  artifactId: stage2ArtifactId,
  version: 1,
  sha256: stage2Sha,
  outcome: "approve",
});
// 7. duplicate id (reuses the first approval's decisionId)
await signal({
  decisionId: "d1-approve-1",
  projectId: PROJECT_ID,
  stage: 2,
  reviewId: "stage-2-review-1",
  artifactId: stage2ArtifactId,
  version: 1,
  sha256: stage2Sha,
  outcome: "approve",
});

// 8. send_back 2 -> 1
await signal({
  decisionId: "d8-send-back",
  projectId: PROJECT_ID,
  stage: 2,
  reviewId: "stage-2-review-1",
  artifactId: stage2ArtifactId,
  version: 1,
  sha256: stage2Sha,
  outcome: "send_back",
  targetStage: 1,
  reason: "needs another pass",
});

const stage1ReopenArtifactId = `${PROJECT_ID}-stage-1-artifact`;
const stage1ReopenContent = "stage 1 brief, revised";
artifactContent[`${stage1ReopenArtifactId}@2`] = stage1ReopenContent;
const stage1ReopenSha = contentSha256(stage1ReopenContent);

// old stage-1 reviewId must now be refused (stale_review)
await signal({
  decisionId: "d9-old-review-refused",
  projectId: PROJECT_ID,
  stage: 1,
  reviewId: "stage-1-review-1",
  artifactId: stage1ArtifactId,
  version: 1,
  sha256: stage1Sha,
  outcome: "approve",
});

// 10. approve(1) with the NEW reviewId
await signal({
  decisionId: "d10-reapprove-1",
  projectId: PROJECT_ID,
  stage: 1,
  reviewId: "stage-1-review-2",
  artifactId: stage1ReopenArtifactId,
  version: 2,
  sha256: stage1ReopenSha,
  outcome: "approve",
});

// 11. approve(2) -- reopened by the reapproval's advance, so it is the
// stage's second review (reviewCounts[2] was 1 from its first opening).
artifactContent[`${stage2ArtifactId}@2`] = stage2Content;
await signal({
  decisionId: "d11-approve-2",
  projectId: PROJECT_ID,
  stage: 2,
  reviewId: "stage-2-review-2",
  artifactId: stage2ArtifactId,
  version: 2,
  sha256: stage2Sha,
  outcome: "approve",
});

const result = await run.complete;

assert(result.terminalStatus === "completed", `run completed (got ${result.terminalStatus})`);

const loopOutput = result.outputs.rework as { outcome: string; iterations: number };
assert(loopOutput.outcome === "converged", `loop converged (got ${loopOutput.outcome})`);
assert(loopOutput.iterations === signalCount, `loop iterations (${String(loopOutput.iterations)}) equal signals delivered (${String(signalCount)})`);

const runCompletedEvents = result.events.filter((e) => e.kind === "RunCompleted");
assert(runCompletedEvents.length === 1, `exactly one RunCompleted event (got ${runCompletedEvents.length})`);

// `carry` is the converging iteration's INPUT (the state it worked from);
// `final` is that iteration's OUTPUT, which is the state the run committed.
const finalOutput = (loopOutput as unknown as { final: { apply: { done: boolean; decisions: Array<{ decisionId: string; accepted: boolean }> } } }).final.apply;
console.log("final committed state:", JSON.stringify(finalOutput, null, 2));

assert(finalOutput.done === true, "final approve set done");

const decisions = finalOutput.decisions;
const refusedIds = ["d2-unauthorized", "d3-stale-review", "d4-wrong-version", "d5-wrong-hash", "d6-wrong-project"];
for (const id of refusedIds) {
  const record = decisions.find((d) => d.decisionId === id);
  assert(!!record && record.accepted === false, `${id} was refused`);
}
assert(!decisions.some((d) => d.decisionId === "d9-old-review-refused" && d.accepted), "old stage-1 review refused after send-back");
assert(decisions.filter((d) => d.decisionId === "d1-approve-1").length === 1, "duplicate decisionId did not append a second record");
assert(!!decisions.find((d) => d.decisionId === "d11-approve-2" && d.accepted), "final approve(2) accepted");

console.log("PASS project workflow proof: approve, refuse, send back, reapprove, complete once");
