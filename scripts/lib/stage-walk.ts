/**
 * The lifecycle stage walk: shared by `sidecar-smoke.ts`, `seed.ts` and
 * `bench-run.ts` so none of them can drift.
 *
 * Advancing past a parked stage is `produce(stage)` writing the stage
 * artifact, then `stage.submit` → settle on `gateStepId(stage)` →
 * `stage.approve` → settle on `stage + 1`. Stages 1-4 go through the engine
 * with a version to submit and approve; stage 5 and beyond advances by raw
 * signal instead (`cost.approve` rather than `stage.approve` at stage 7).
 *
 * `walkToStage` writes the stage artifact one of two ways:
 *
 * - `mode: "real"` (the default): it delivers a `stage.draft` round signal
 *   the way the product's own "Draft" button does, waits for the workflow's
 *   own persist to write the resulting versions, and returns them to submit.
 *   `provenance.producer` is asserted to be `"agent"` on every version this
 *   writes — a future change that silently reverts to canned text fails
 *   loudly here.
 * - `mode: "seeded"`: the canned-text shortcut (`produceStageArtifact` /
 *   `produceStageArtifacts`), for jumping straight to a stage to experiment
 *   there without sitting through every earlier one's real round. Its
 *   artifacts are legitimately `provenance.producer: "human"` — nobody's
 *   model wrote them.
 */
import { execute, type Actor } from "../../apps/hub/src/command-dispatch.js";
import { newId } from "../../apps/hub/src/ids.js";
import { writeArtifact, readArtifactNode, projectDetail, exportArtifactNodes, type PortableArtifactNode } from "../../apps/hub/src/projects.js";
import { roundInference } from "../../apps/hub/src/stage-runs.js";
import {
  deliverStageSignal,
  projectExecutionStatus,
  type DeliveryOutcome,
  type StageStatus,
} from "../../apps/hub/src/lifecycle-run.js";
import { deliverRound } from "../../apps/hub/src/gate-delivery.js";
import { DRAFT_STEP_TIMEOUT_MS, gateStepId } from "@solutions-builder/app/workflows/stage-loop";
import type { Command, Stage } from "@solutions-builder/app/ledger";

export type WalkMode = "real" | "seeded";

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
  /** Kept for callers; nothing renders it into a prompt anymore — the workflow owns the prompt. */
  readonly projectTitle?: string;
}

const currentRunId = async (ctx: WalkContext) => (await projectDetail(ctx.projectId, ctx.actor.principalId)).current!.id;

/** A version the workflow's own persist wrote for one of the round's steps, with the step that wrote it. */
export type RoundVersion = ArtifactVersion & {
  kind: string;
  stepId: string;
  content: string;
  model?: string;
  providerId?: string;
};

/** The whole point of `mode: "real"`: a future change that silently reverts to canned text must fail loudly. */
async function assertAgentProvenance(nodeId: string, label: string): Promise<void> {
  const { node } = await readArtifactNode(nodeId);
  const producer = (node.provenance as { producer?: string } | null)?.producer;
  if (producer !== "agent") {
    throw new Error(`walkToStage: ${label}'s artifact ${nodeId} has provenance.producer=${JSON.stringify(producer)}, expected "agent"`);
  }
}

const versionOf = (version: RoundVersion): ArtifactVersion => ({
  artifactId: version.artifactId,
  versionId: version.versionId,
  contentHash: version.contentHash,
});

const toRoundVersion = (node: PortableArtifactNode): RoundVersion => {
  const provenance = (node.provenance ?? {}) as { stepRef?: unknown; modelKey?: unknown };
  const stepRef = typeof provenance.stepRef === "string" ? provenance.stepRef : null;
  return {
    artifactId: node.artifactId,
    versionId: node.id,
    contentHash: node.contentHash,
    kind: node.kind,
    stepId: stepRef?.split("/").at(-1) ?? "unknown",
    content: node.content,
    ...(typeof provenance.modelKey === "string" ? { model: provenance.modelKey } : {}),
  };
};

export interface DraftSignal {
  readonly message?: string;
  readonly audiences?: readonly string[];
  readonly mode?: "final" | "interview";
}

/**
 * Delivers a `stage.draft` round envelope to the run parked at `stage` — the
 * same signal the product's own "Draft" button sends through the stage
 * routes — and throws unless a run was there to hear it. Prompt and persist
 * from here are the workflow's: this returns once the signal lands, not once
 * versions exist (see `awaitFreshVersions`).
 */
export async function signalDraft(ctx: WalkContext, stage: Stage, signal: DraftSignal = {}): Promise<DeliveryOutcome> {
  const delivery = await deliverRound(
    {
      type: "stage.draft",
      actor: ctx.actor,
      projectId: ctx.projectId,
      idempotencyKey: newId.command(),
      correlationId: newId.correlation(),
      payload: {
        runId: await currentRunId(ctx),
        message: signal.message ?? "",
        mode: signal.mode ?? "final",
        draft: true,
        ...(signal.audiences ? { audiences: [...signal.audiences] } : {}),
        inference: await roundInference(stage),
      },
    },
    stage,
  );
  if (delivery !== "delivered") {
    throw new Error(`walkToStage: stage ${stage} has no run waiting for this stage (delivery ${delivery ?? "none"}); nothing was drafted.`);
  }
  return delivery;
}

/**
 * Waits for the workflow's own persist to write an agent-provenance version
 * of every kind in `kinds` that was not in `beforeIds` when the round was
 * signalled, and returns them oldest first. Throws naming the kinds that
 * never arrived: the signal succeeding while nothing persists means the
 * workflow's half is missing, and that must fail loudly rather than submit
 * canned text.
 */
export async function awaitFreshVersions(
  ctx: WalkContext,
  kinds: readonly string[],
  beforeIds: ReadonlySet<string>,
  timeoutMs = DRAFT_STEP_TIMEOUT_MS,
): Promise<RoundVersion[]> {
  const started = Date.now();
  for (;;) {
    const { nodes } = await exportArtifactNodes(ctx.projectId);
    const fresh = nodes.filter((node) => kinds.includes(node.kind) && !beforeIds.has(node.id));
    if (kinds.every((kind) => fresh.some((node) => node.kind === kind))) {
      for (const node of fresh) await assertAgentProvenance(node.id, `stage draft ${node.kind}`);
      return fresh.map(toRoundVersion);
    }
    if (Date.now() - started >= timeoutMs) {
      const missing = kinds.filter((kind) => !fresh.some((node) => node.kind === kind));
      throw new Error(
        `walkToStage: no agent-persisted ${missing.join(", ")} arrived within ${Math.round(timeoutMs / 1000)}s of the stage.draft signal. ` +
          "The workflow owns prompt and persist from the signal; the signal was delivered but nothing wrote versions.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

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
 * Runs the stage's real round the way the product's own "Draft" button does:
 * delivers a `stage.draft` round signal and waits for the workflow's own
 * persist to write the resulting versions, returned oldest first.
 */
export async function draftStageArtifact(
  ctx: WalkContext,
  stage: 1 | 2 | 3 | 4,
  input = "",
  opts?: { audiences?: readonly string[] },
): Promise<ArtifactVersion[]> {
  const before = new Set((await exportArtifactNodes(ctx.projectId)).nodes.map((node) => node.id));
  await signalDraft(ctx, stage, { message: input, ...(opts?.audiences ? { audiences: opts.audiences } : {}) });
  return (await awaitFreshVersions(ctx, [STAGE_ARTIFACT[stage]], before)).map(versionOf);
}

/**
 * Advances a run parked at `stage` to `stage + 1`. Stages 1-4 submit and
 * approve `versions` through dispatch; stage 5 and beyond submits and
 * approves by gate signal (`cost.approve` at stage 7). Both paths record
 * the command when `runGateSideEffects` delivers — not only `commandFrom`.
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
  // The same named signals a person's client delivers, with the same thin
  // intent; the ledger records them on the next status read.
  const submitDelivery = await deliverStageSignal(
    ctx.projectId,
    "stage.submit",
    { command: "stage.submit", runId: ctx.runId },
    `walk-submit-${stage}-${ctx.projectId}`,
    stage,
  );
  const gate = await settleStatus(ctx.projectId, (s) => s.parked && s.stepId === gateStepId(stage));
  const advance: Command = stage === 7 ? "cost.approve" : "stage.approve";
  const approveDelivery = await deliverStageSignal(
    ctx.projectId,
    advance,
    { command: advance, runId: ctx.runId },
    `walk-approve-${stage}-${ctx.projectId}`,
    stage,
  );
  const next = await settleStatus(ctx.projectId, (s) => s.parked && s.stage === stage + 1);
  return { submitDelivery: submitDelivery ?? "none", gate, approveDelivery: approveDelivery ?? "none", next };
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
        content: await benchArtifactContent(entry.kind, entry.title),
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

/**
 * Runs stage N's (5-7) real round the way the product's own "Draft" button
 * does: delivers a `stage.draft` round signal and waits for the workflow's
 * own persist to write the resulting versions. Stage 6's requirements come
 * back before its plan, matching the order a `stage.submit` names them; the
 * panel's four reviews are advisory and are never among the versions a
 * `stage.submit` names, matching what the canned `STAGE_5_TO_7_ARTIFACT`
 * shape submits.
 */
export async function draftStageArtifacts(
  ctx: WalkContext,
  stage: 5 | 6 | 7,
  input = "",
  opts?: { audiences?: readonly string[] },
): Promise<ArtifactVersion[]> {
  const before = new Set((await exportArtifactNodes(ctx.projectId)).nodes.map((node) => node.id));
  await signalDraft(ctx, stage, { message: input, ...(opts?.audiences ? { audiences: opts.audiences } : {}) });
  const kinds = stage === 5 ? ["audience_package"] : stage === 6 ? ["product_requirements", "build_plan"] : ["cost_approval"];
  const versions = await awaitFreshVersions(ctx, kinds, before);
  versions.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  return versions.map(versionOf);
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
 * `mode` (default `"real"`) is what writes each stage's artifact: `"real"`
 * delivers the stage's `stage.draft` round signal, the same path the
 * product's own "Draft" button takes, and asserts `provenance.producer
 * === "agent"` on every version it writes; `"seeded"` is the canned-text
 * shortcut, for jumping to a stage without sitting through every earlier
 * one's real round, and its versions are legitimately `"human"`.
 *
 * Throws, naming the stage and the last observed step/signal, the moment a
 * stage fails to settle — nothing here retries or falls back silently.
 */
export async function walkToStage(
  ctx: WalkContext,
  targetStage: Stage,
  audienceName?: string,
  mode: WalkMode = "real",
): Promise<StageStatus> {
  const parkedAt1 = await settleStatus(ctx.projectId, (s) => s.parked && s.stage === 1);
  if (!parkedAt1) throw new Error(`walkToStage: project ${ctx.projectId} never parked at stage 1`);
  let latest = parkedAt1;
  for (let stage = 1; stage < targetStage; stage++) {
    if (stage <= 4) {
      const versions =
        mode === "seeded"
          ? await produceStageArtifact(ctx, stage as 1 | 2 | 3 | 4)
          : await draftStageArtifact(ctx, stage as 1 | 2 | 3 | 4);
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

    const versions =
      mode === "seeded" ? await produceStageArtifacts(ctx, stage as 5 | 6 | 7) : await draftStageArtifacts(ctx, stage as 5 | 6 | 7);
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
        // `placement` is where the build runs; `targets` is what is being
        // built. They are not the same axis, and conflating them left the
        // verifier with nothing it knew how to exercise.
        targets: ["cli"],
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

async function benchArtifactContent(kind: string, title: string): Promise<string> {
  const dir = process.env["BENCH_PACKET_DIR"];
  if (dir === undefined) return `# ${title}\n\nRecorded at ${new Date().toISOString()}.`;
  const file = kind === "product_requirements" ? "PACKET_REQUIREMENTS.md" : kind === "build_plan" ? "PACKET_BUILD_PLAN.md" : null;
  if (file === null) return `# ${title}\n\nRecorded at ${new Date().toISOString()}.`;
  const handle = Bun.file(`${dir}/${file}`);
  if (!(await handle.exists())) throw new Error(`BENCH_PACKET_DIR: ${dir}/${file} missing`);
  return await handle.text();
}
