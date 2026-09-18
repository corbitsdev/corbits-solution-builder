/**
 * The stage conversation and open question, folded in the browser.
 *
 * Same rule as `apps/hub/src/stage-thread.ts`, over the same `/hub` events:
 * `@solutions-builder/app/stage-thread`'s `projectStageThread` and
 * `nextOpenQuestion`. The iterations' events and the round/draft steps' blob
 * refs are fetched here, over the `/hub` passthrough; the artifact nodes, the
 * stage-1 opening statement and any turns carried in from another instance
 * are ledger data `GET /projects/:id` already carries on `ProjectDetail`,
 * since none of that is a run event.
 */
import { listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import {
  evaluationIn,
  nextOpenQuestion,
  projectStageThread,
  type ArtifactNodeRef,
  type OutputResolver,
  type StageIteration,
  type StageTurn,
} from "@solutions-builder/app/stage-thread";
import { reviseStepId } from "@solutions-builder/app/workflows/stage-loop";
import type { Stage } from "@solutions-builder/app/ledger";
import { createHubTransport } from "./hub.ts";

export { nextOpenQuestion };
export type { StageTurn };

/**
 * A fan-out loop iteration's run id, encoded the way `@intx/workflow`'s
 * `loopBodyRunId` does. Reimplemented rather than imported: the browser has
 * no dependency on the runtime package, only on the events it commits.
 */
function loopBodyRunId(anchorRunId: string, loopId: string, index: number): string {
  return `${anchorRunId}__${loopId}__${String(index)}`;
}

/**
 * Resolves a step output ref over the `/hub` passthrough: `inline:<json>` is
 * parsed directly, `blob:<sha>` is fetched through the deployment's blob
 * route — a local addition to the hub with no upstream client op in
 * `@intx/hub-client`, so its path is hand-rolled here the same way
 * `apps/hub/src/hub-client.ts`'s `deploymentRuns.blob` rolls it host-side.
 */
function readRefOver(tenantId: string, transport: Transport): OutputResolver {
  return async (anchor, runId, ref) => {
    if (ref.startsWith("inline:")) return JSON.parse(ref.slice("inline:".length));
    const match = /^blob:(.+)$/.exec(ref);
    if (!match) throw new Error(`Unrecognized step output ref: ${ref}`);
    return transport.fetch("GET", `/api/tenants/${tenantId}/workflows/${anchor}/runs/${runId}/blobs/${match[1]}`);
  };
}

/** Every iteration child run of a stage's revise loop under the current anchor, oldest first. */
async function stageIterations(
  tenantId: string,
  anchorRunId: string,
  stage: Stage,
  transport: Transport,
): Promise<StageIteration[]> {
  const runIds = new Set(await listWorkflowRuns(transport, tenantId, anchorRunId));
  const loopId = reviseStepId(stage);
  const iterations: StageIteration[] = [];
  for (let index = 0; ; index += 1) {
    const runId = loopBodyRunId(anchorRunId, loopId, index);
    if (!runIds.has(runId)) break;
    const { events } = await readWorkflowRunEvents(transport, tenantId, anchorRunId, runId);
    iterations.push({ runId, events });
  }
  return iterations;
}

export type ThreadArgs = {
  readonly tenantId: string;
  /** Null when the lifecycle has not been placed yet: no iterations to fold. */
  readonly anchorRunId: string | null;
  readonly stage: Stage;
  readonly nodes: readonly ArtifactNodeRef[];
  /** `ProjectDetail.opening`, passed through only at stage 1 by the caller. */
  readonly opening: { readonly body: string; readonly createdAt: string } | null;
  /** `ProjectDetail.carriedTurns`, already filtered to this stage by the caller. */
  readonly carried: readonly StageTurn[];
  readonly transport?: Transport;
};

/** The stage thread: `/hub` events folded, with the ledger turns `ProjectDetail` carries stitched in ahead of them. */
export async function foldStageThread(args: ThreadArgs): Promise<StageTurn[]> {
  const transport = args.transport ?? createHubTransport();
  const iterations = args.anchorRunId
    ? await stageIterations(args.tenantId, args.anchorRunId, args.stage, transport)
    : [];
  const here = await projectStageThread({
    iterations,
    nodes: args.nodes,
    opening: args.opening,
    readRef: readRefOver(args.tenantId, transport),
  });
  if (args.carried.length === 0) return here;
  // What was carried in happened before anything that ran here; the opening
  // statement, when there is one, came before all of it.
  const [first, ...rest] = here;
  const before = first?.id === "opening" ? [first] : [];
  const after = first?.id === "opening" ? rest : here;
  return [...before, ...args.carried, ...after];
}

/** The latest brief-evaluator verdict for the stage, or null before one has run. */
export async function foldEvaluation(args: {
  readonly tenantId: string;
  readonly anchorRunId: string | null;
  readonly stage: Stage;
  readonly transport?: Transport;
}): Promise<{ ready: boolean; notes: string[] } | null> {
  if (args.anchorRunId === null) return null;
  const transport = args.transport ?? createHubTransport();
  const iterations = await stageIterations(args.tenantId, args.anchorRunId, args.stage, transport);
  return evaluationIn(iterations, readRefOver(args.tenantId, transport));
}
