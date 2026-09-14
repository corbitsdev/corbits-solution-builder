/**
 * The lifecycle stage walk: shared by `sidecar-smoke.ts` and `seed.ts` so the
 * two cannot drift.
 *
 * Advancing past a parked stage is `produce(stage)` writing the stage
 * artifact, then `stage.submit` → settle on `gateStepId(stage)` →
 * `stage.approve` → settle on `stage + 1`. Stages 1-4 go through the engine
 * with a version to submit and approve; stage 5 and beyond advances by raw
 * signal instead (`cost.approve` rather than `stage.approve` at stage 7).
 */
import { execute, type Actor } from "../../apps/hub/src/engine.js";
import { newId } from "../../apps/hub/src/ids.js";
import { writeArtifact, projectDetail } from "../../apps/hub/src/projects.js";
import { deliverStageSignal, projectExecutionStatus, type StageStatus } from "../../apps/hub/src/hub-executor.js";
import { gateStepId } from "@solutions-builder/app/workflows/stage-loop";
import type { Stage } from "@solutions-builder/app/ledger";

export const STAGE_ARTIFACT: Record<1 | 2 | 3 | 4, string> = {
  1: "problem_brief",
  2: "solution_constraints",
  3: "chosen_approach",
  4: "design_artifact",
};

export type ArtifactVersion = { artifactId: string; versionId: string; contentHash: string };

export interface WalkContext {
  readonly projectId: string;
  readonly runId: string;
  readonly actor: Actor;
}

const currentRunId = async (ctx: WalkContext) => (await projectDetail(ctx.projectId, ctx.actor.principalId)).current!.id;

/** Waits for the project's run to reach a status `until` accepts, or times out at `null`. */
export async function settleStatus(
  projectId: string,
  until: (status: StageStatus) => boolean,
  timeoutMs = 60_000,
): Promise<StageStatus | null> {
  const started = Date.now();
  let latest: StageStatus | null = null;
  while (Date.now() - started < timeoutMs) {
    latest = await projectExecutionStatus(projectId).catch(() => null);
    if (latest && until(latest)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return latest;
}

/** Writes stage N's fixed artifact and returns it as a version to submit. */
export async function produceStageArtifact(
  ctx: WalkContext,
  stage: 1 | 2 | 3 | 4,
  content = `# Stage ${stage}\n\nRecorded at ${new Date().toISOString()}.`,
): Promise<ArtifactVersion[]> {
  const node = await writeArtifact(
    {
      projectId: ctx.projectId,
      kind: STAGE_ARTIFACT[stage] as never,
      title: `Stage ${stage} artifact`,
      content,
      mediaType: "text/markdown",
      sourceVersionIds: [],
      provenance: { producer: "human", runId: await currentRunId(ctx) },
    },
    ctx.actor,
  );
  return [{ artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash }];
}

/**
 * Advances a run parked at `stage` to `stage + 1`. Stages 1-4 submit and
 * approve `versions` through the engine; stage 5 and beyond submits and
 * approves by raw signal (`cost.approve` at stage 7).
 */
export interface AdvanceResult {
  readonly submitDelivery: string;
  readonly gate: StageStatus | null;
  readonly approveDelivery: string;
  readonly next: StageStatus | null;
}

export async function advanceStage(ctx: WalkContext, stage: Stage, versions?: ArtifactVersion[]): Promise<AdvanceResult> {
  if (stage <= 4) {
    if (!versions) throw new Error(`advanceStage(${stage}) needs versions to submit and approve`);
    const command = (type: string, payload: Record<string, unknown>) =>
      execute({
        type: type as never,
        actor: ctx.actor,
        projectId: ctx.projectId,
        idempotencyKey: newId.command(),
        correlationId: newId.correlation(),
        payload,
      });
    const submitted = await command("stage.submit", { runId: await currentRunId(ctx), versions });
    const gate = await settleStatus(ctx.projectId, (s) => s.parked && s.stepId === gateStepId(stage));
    const approved = await command("stage.approve", { runId: await currentRunId(ctx), versions });
    const next = await settleStatus(ctx.projectId, (s) => s.parked && s.stage === stage + 1);
    return { submitDelivery: submitted.delivery ?? "none", gate, approveDelivery: approved.delivery ?? "none", next };
  }
  const submitDelivery = await deliverStageSignal(ctx.projectId, "stage.submit", { runId: ctx.runId }, `walk-submit-${stage}-${ctx.projectId}`);
  const gate = await settleStatus(ctx.projectId, (s) => s.parked && s.stepId === gateStepId(stage));
  const advance = stage === 7 ? "cost.approve" : "stage.approve";
  const approveDelivery = await deliverStageSignal(ctx.projectId, advance, { runId: ctx.runId }, `walk-approve-${stage}-${ctx.projectId}`);
  const next = await settleStatus(ctx.projectId, (s) => s.parked && s.stage === stage + 1);
  return { submitDelivery, gate, approveDelivery, next };
}

/**
 * Fixed artifacts for stages 5-7, the ones a real `stage.submit`/`stage.approve`
 * (or `cost.approve`) needs to leave that stage's run consistent — matched to
 * `ARTIFACT_STAGE` in `@solutions-builder/app/artifacts`. `walkToStage` (below)
 * writes these directly, the same canned-content approach `produceStageArtifact`
 * takes for stages 1-4, never through an agent.
 */
const STAGE_5_TO_7_ARTIFACT: Record<5 | 6 | 7, { kind: string; title: string }[]> = {
  5: [{ kind: "audience_package", title: "Audience package" }],
  6: [
    { kind: "product_requirements", title: "Product requirements" },
    { kind: "build_plan", title: "Build plan" },
  ],
  7: [{ kind: "cost_approval", title: "Cost approval" }],
};

/** Writes stage N's (5-7) fixed artifacts and returns them as versions to submit. */
export async function produceStageArtifacts(ctx: WalkContext, stage: 5 | 6 | 7): Promise<ArtifactVersion[]> {
  const runId = await currentRunId(ctx);
  const versions: ArtifactVersion[] = [];
  for (const entry of STAGE_5_TO_7_ARTIFACT[stage]) {
    const node = await writeArtifact(
      {
        projectId: ctx.projectId,
        kind: entry.kind as never,
        title: entry.title,
        content: `# ${entry.title}\n\nRecorded at ${new Date().toISOString()}.`,
        mediaType: "text/markdown",
        sourceVersionIds: [],
        provenance: { producer: "human", runId },
      },
      ctx.actor,
    );
    versions.push({ artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash });
  }
  return versions;
}

/** Runs one ledger command as this actor, the same shape `advanceStage` uses inline for stages 1-4. */
export function runCommand(ctx: WalkContext, type: string, payload: Record<string, unknown>) {
  return execute({
    type: type as never,
    actor: ctx.actor,
    projectId: ctx.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload,
  });
}

/**
 * Waits for a freshly created project to park at stage 1, then walks it up to
 * (not through) `targetStage`: stages before it are drafted, submitted and
 * approved, and the run parks at `targetStage` waiting on its own round.
 *
 * Stages 1-4 go through the engine with a produced artifact, via
 * `advanceStage` — unchanged from what `sidecar-smoke.ts` also drives. Stage 5
 * needs a real, ledger-consistent stage 8 to hand off to (`build.start_attempt`
 * checks the ledger's own `build/queued` state, which a raw signal never
 * writes), so stages 5-7 go through the engine for real too: stage 5 submits
 * an audience package and records `audienceName`'s decision to clear the
 * quorum before approving; stage 6 submits its requirements and plan; stage 7
 * submits its cost approval, calls `cost.approve`, then `build.freeze`, which
 * is what actually opens the stage 8 build run. `audienceName` must name one
 * of the project's configured audiences whenever the walk passes stage 5.
 *
 * Throws, naming the stage and the last observed step/signal, the moment a
 * stage fails to settle — nothing here retries or falls back silently.
 */
export async function walkToStage(ctx: WalkContext, targetStage: Stage, audienceName?: string): Promise<StageStatus> {
  const parkedAt1 = await settleStatus(ctx.projectId, (s) => s.parked && s.stage === 1);
  if (!parkedAt1) throw new Error(`walkToStage: project ${ctx.projectId} never parked at stage 1`);
  let latest = parkedAt1;
  for (let stage = 1; stage < targetStage; stage++) {
    if (stage <= 4) {
      const versions = await produceStageArtifact(ctx, stage as 1 | 2 | 3 | 4);
      const result = await advanceStage(ctx, stage as Stage, versions);
      if (!result.gate || result.gate.stepId !== gateStepId(stage as Stage)) {
        throw new Error(
          `walkToStage: stage ${stage} never reached its gate (last observed: ${result.gate ? `${result.gate.stepId} ${result.gate.signalName ?? ""}` : "no status"})`,
        );
      }
      if (!result.next || result.next.stage !== stage + 1) {
        throw new Error(
          `walkToStage: stage ${stage} did not advance to stage ${stage + 1} (last observed: ${result.next ? `${result.next.stepId} ${result.next.signalName ?? ""}` : "no status"})`,
        );
      }
      latest = result.next;
      continue;
    }

    if (stage === 5 && !audienceName) {
      throw new Error("walkToStage: an audienceName is required to clear stage 5's quorum");
    }

    const versions = await produceStageArtifacts(ctx, stage as 5 | 6 | 7);
    await runCommand(ctx, "stage.submit", { runId: await currentRunId(ctx), versions });
    const gate = await settleStatus(ctx.projectId, (s) => s.parked && s.stepId === gateStepId(stage as Stage));
    if (!gate) {
      throw new Error(`walkToStage: stage ${stage} never reached its gate after stage.submit`);
    }

    if (stage === 5) {
      await runCommand(ctx, "audience.decide", {
        runId: await currentRunId(ctx),
        audienceName,
        decision: "proceed",
        versions,
      });
    }

    if (stage === 7) {
      await runCommand(ctx, "cost.approve", {
        runId: await currentRunId(ctx),
        versions,
        forecastUsd: 1800,
        assumptions: ["Seeded: within the workspace's stated cost tolerance."],
      });
      await runCommand(ctx, "build.freeze", {
        runId: await currentRunId(ctx),
        versions,
        placement: "local",
        targets: ["local"],
      });
    } else {
      await runCommand(ctx, "stage.approve", { runId: await currentRunId(ctx), versions });
    }

    const next = await settleStatus(ctx.projectId, (s) => s.parked && s.stage === stage + 1);
    if (!next || next.stage !== stage + 1) {
      throw new Error(
        `walkToStage: stage ${stage} did not advance to stage ${stage + 1} (last observed: ${next ? `${next.stepId} ${next.signalName ?? ""}` : "no status"})`,
      );
    }
    latest = next;
  }
  return latest;
}
