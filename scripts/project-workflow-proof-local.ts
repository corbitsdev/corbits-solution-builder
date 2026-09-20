import "./smoke-env.ts";

import { runLocal, type ActionHandler, type LoopFn } from "@intx/workflow";
import { applyDecision, holdState, initProject, recordExhausted } from "../packages/solutions-builder/src/project-workflow/actions.ts";
import { projectWorkflowLoopCarry, projectWorkflowLoopWhile } from "../packages/solutions-builder/src/project-workflow/loops.ts";
import { PROJECT_DECISION_SIGNAL, projectWorkflow } from "../packages/solutions-builder/src/project-workflow/workflow.ts";

const PROJECT_ID = "proof-project";
const OWNER = "owner-principal";
const AT = "2026-09-19T00:00:00.000Z";

const handlers: Record<string, ActionHandler> = { initProject, holdState, applyDecision, recordExhausted };
const loopFns: Record<string, LoopFn> = { projectWorkflowLoopWhile, projectWorkflowLoopCarry };

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
  await run.signal(PROJECT_DECISION_SIGNAL, { principalId, decision }, `sig-${String(signalCount)}`);
}

// REAL-SHAPED references throughout: any artifact id/version/sha string --
// the workflow never reads an artifact's content, only compares the
// reference a decision names against the one an earlier decision opened.
const stage1ArtifactId = `${PROJECT_ID}-stage-1-artifact`;
const stage1Sha = "sha256:stage-1-v1";

// 1. open_review(1)
await signal({ decisionId: "d1-open-1", kind: "open_review", projectId: PROJECT_ID, stage: 1, artifactId: stage1ArtifactId, version: 1, sha256: stage1Sha, at: AT });

// 2. approve(1)
await signal({ decisionId: "d2-approve-1", kind: "approve", projectId: PROJECT_ID, stage: 1, reviewId: "stage-1-review-1", artifactId: stage1ArtifactId, version: 1, sha256: stage1Sha, at: AT });

const stage2ArtifactId = `${PROJECT_ID}-stage-2-artifact`;
const stage2Sha = "sha256:stage-2-v1";

// 3. open_review(2)
await signal({ decisionId: "d3-open-2", kind: "open_review", projectId: PROJECT_ID, stage: 2, artifactId: stage2ArtifactId, version: 1, sha256: stage2Sha, at: AT });

// 4. unauthorized
await signal(
  { decisionId: "d4-unauthorized", kind: "approve", projectId: PROJECT_ID, stage: 2, reviewId: "stage-2-review-1", artifactId: stage2ArtifactId, version: 1, sha256: stage2Sha, at: AT },
  "intruder-principal",
);
// 5. stale reviewId
await signal({ decisionId: "d5-stale-review", kind: "approve", projectId: PROJECT_ID, stage: 2, reviewId: "stage-2-review-0-stale", artifactId: stage2ArtifactId, version: 1, sha256: stage2Sha, at: AT });
// 6. wrong version
await signal({ decisionId: "d6-wrong-version", kind: "approve", projectId: PROJECT_ID, stage: 2, reviewId: "stage-2-review-1", artifactId: stage2ArtifactId, version: 99, sha256: stage2Sha, at: AT });
// 7. wrong hash
await signal({ decisionId: "d7-wrong-hash", kind: "approve", projectId: PROJECT_ID, stage: 2, reviewId: "stage-2-review-1", artifactId: stage2ArtifactId, version: 1, sha256: "sha256:wrong", at: AT });
// 8. wrong project
await signal({ decisionId: "d8-wrong-project", kind: "approve", projectId: "not-this-project", stage: 2, reviewId: "stage-2-review-1", artifactId: stage2ArtifactId, version: 1, sha256: stage2Sha, at: AT });
// 9. duplicate id (reuses the open_review's decisionId)
await signal({ decisionId: "d3-open-2", kind: "approve", projectId: PROJECT_ID, stage: 2, reviewId: "stage-2-review-1", artifactId: stage2ArtifactId, version: 1, sha256: stage2Sha, at: AT });

// 10. send_back 2 -> 1
await signal({ decisionId: "d10-send-back", kind: "send_back", projectId: PROJECT_ID, stage: 2, targetStage: 1, reason: "needs another pass", at: AT });

// the old stage-1 reviewId must now be refused (stale_review): no review is
// open at stage 1 until a fresh open_review names one.
await signal({ decisionId: "d11-old-review-refused", kind: "approve", projectId: PROJECT_ID, stage: 1, reviewId: "stage-1-review-1", artifactId: stage1ArtifactId, version: 1, sha256: stage1Sha, at: AT });

const stage1ReopenSha = "sha256:stage-1-v2";
// 12. open_review(1) again, then reapprove with the NEW review
await signal({ decisionId: "d12-open-1-again", kind: "open_review", projectId: PROJECT_ID, stage: 1, artifactId: stage1ArtifactId, version: 2, sha256: stage1ReopenSha, at: AT });
await signal({ decisionId: "d13-reapprove-1", kind: "approve", projectId: PROJECT_ID, stage: 1, reviewId: "stage-1-review-2", artifactId: stage1ArtifactId, version: 2, sha256: stage1ReopenSha, at: AT });

// 14. approve(2) -- stage 2's review was marked stale by the send-back, so it
// must be reopened before it can be approved again.
await signal({ decisionId: "d14-open-2-again", kind: "open_review", projectId: PROJECT_ID, stage: 2, artifactId: stage2ArtifactId, version: 2, sha256: stage2Sha, at: AT });
await signal({ decisionId: "d15-approve-2", kind: "approve", projectId: PROJECT_ID, stage: 2, reviewId: "stage-2-review-2", artifactId: stage2ArtifactId, version: 2, sha256: stage2Sha, at: AT });

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
const refusedIds = ["d4-unauthorized", "d5-stale-review", "d6-wrong-version", "d7-wrong-hash", "d8-wrong-project"];
for (const id of refusedIds) {
  const record = decisions.find((d) => d.decisionId === id);
  assert(!!record && record.accepted === false, `${id} was refused`);
}
assert(!decisions.some((d) => d.decisionId === "d11-old-review-refused" && d.accepted), "old stage-1 review refused after send-back");
assert(decisions.filter((d) => d.decisionId === "d3-open-2").length === 2, "duplicate decisionId appended one refusal record, not a second success");
assert(!!decisions.find((d) => d.decisionId === "d15-approve-2" && d.accepted), "final approve(2) accepted");

console.log("PASS project workflow proof: open review, approve, refuse, send back, reopen, reapprove, complete once");
