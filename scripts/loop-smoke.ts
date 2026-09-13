/**
 * End-to-end loop smoke.
 *
 * Drives one project from creation to delivery through the real host API,
 * exercising the gate rules rather than a happy path: it asserts that the
 * refusals fire (approving stage 7 directly, freezing twice, approving a stale
 * version) as well as that the nine stages advance.
 *
 * Artifacts are written by the host's own artifact writer rather than by a
 * model, so the loop is provable without a provider connection. The stage
 * specialists are exercised separately, by using the app.
 *
 * Usage: bun scripts/loop-smoke.ts [--port 7788]
 */
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub, evaluate, listRoles, assignRole, localActor, tenantId } from "../apps/hub/src/hub-client.js";
import { install } from "../apps/hub/src/install.js";
import { ensureUserPrincipal } from "../apps/hub/src/hub-gaps.js";
import {
  createProject,
  listProjects,
  projectDetail,
  writeArtifact,
} from "../apps/hub/src/projects.js";
import { execute, HOST_PRINCIPAL, submitAndApprove } from "../apps/hub/src/engine.js";
import { activeRun } from "../apps/hub/src/runs.js";
import { newId } from "../apps/hub/src/ids.js";
import { HostError } from "../apps/hub/src/errors.js";
import { openDecisionFor } from "../apps/hub/src/decisions.js";
import { workspaceFor } from "../apps/hub/src/corbits-exec.js";
import { abortBuildAttempt, liveBuild, startBuildAttempt, subscribeBuildOutput } from "../apps/hub/src/build-attempt.js";
import { buildEvents } from "../apps/hub/src/engine-ledger.js";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DELIVERED_BYTES = Buffer.from("the delivered application bytes\n");
const DELIVERED_SHA = createHash("sha256").update(DELIVERED_BYTES).digest("hex");
import type { ArtifactKind } from "../apps/hub/src/domain.js";
import { AUTHORITIES, type Command, type Stage } from "@solutions-builder/app/ledger";
import { alignmentStep, positionOfSignal, roundSignal, approveSignal, exhaustedSignal } from "@solutions-builder/app/workflows/stage-loop";

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

/** The host relays a verified worker request; a human never raises one. */
const HOST_ACTOR = { principalId: HOST_PRINCIPAL, displayName: "Solutions Builder host" };

async function command(
  type: Command,
  projectId: string,
  payload: Record<string, unknown>,
  actor = ACTOR,
) {
  const outcome = await execute({
    type,
    actor,
    projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload,
  });
  return outcome;
}

async function refuses(
  name: string,
  expected: string,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work();
    check(name, false, "the command was accepted when it should have been refused");
  } catch (cause) {
    const refusal =
      cause instanceof HostError ? String(cause.detail.refusal ?? cause.code) : "unknown";
    check(name, refusal === expected, `refused with ${refusal}`);
  }
}

const STAGE_ARTIFACT: Record<number, ArtifactKind> = {
  1: "problem_brief",
  2: "solution_constraints",
  3: "chosen_approach",
  4: "design_artifact",
  5: "audience_package",
  6: "build_plan",
  7: "cost_approval",
};

const dataDir = process.env.SOLUTIONS_BUILDER_DATA_DIR;
const host = await openDatabase(dataDir ? `${dataDir}/pglite-smoke` : undefined);
await prepareDatabase(host);
await ensureHub();
// The actor's ledger authorities come from the platform's roles, which the
// install writes — the same install the client asks for on first launch.
await install();
const ACTOR = { ...localActor(), displayName: "Smoke" };

const created = await createProject({
  title: "Smoke: a chess game I can actually play",
  owner: ACTOR,
  policy: {
    costTolerancePercent: 15,
    costToleranceAbsolute: 500,
    audiences: [{ name: "Project owner", role: "project_owner" }],
    audienceQuorum: 1,
    allowExternalProviders: false,
  },
});
check("project.create produced a project at stage 1", Boolean(created.projectId));

async function produce(stage: Stage, projectId: string, runId: string) {
  const kind = STAGE_ARTIFACT[stage];
  if (!kind) throw new Error(`No artifact kind for stage ${stage}`);
  return writeArtifact(
    {
      projectId,
      kind,
      title: `Stage ${stage} artifact`,
      content: `# Stage ${stage}\n\nRecorded by the loop smoke at ${new Date().toISOString()}.`,
      mediaType: "text/markdown",
      sourceVersionIds: [],
      provenance: { producer: "human", runId },
    },
    ACTOR,
  );
}

const { projectId } = created;

// --- Stages 1 to 4: draft, submit, approve ---
for (const stage of [1, 2, 3, 4] as Stage[]) {
  const detail = await projectDetail(projectId, ACTOR.principalId);
  const run = detail.current!;
  const node = await produce(stage, projectId, run.id);

  if (stage === 1) {
    const drafted = await command("stage.draft", projectId, {
      runId: run.id,
      message: "Here's the problem as I see it.",
      quotes: [],
    });
    check(
      "stage.draft from in_progress is accepted and leaves the run open at the same stage",
      drafted.stage === 1 && drafted.state === "in_progress",
      `stage=${drafted.stage} state=${drafted.state}`,
    );
  }

  await command("stage.submit", projectId, {
    runId: run.id,
    versions: [{ artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash }],
  });

  if (stage === 1) {
    await refuses(
      "stage.draft after stage.submit is refused: the stage is waiting_approval, not in_progress",
      "wrong_state",
      () => command("stage.draft", projectId, { runId: run.id, message: "One more pass?", quotes: [] }),
    );

    const waiting = await projectDetail(projectId, ACTOR.principalId);
    check(
      "submitting puts a decision in the queue, derived from the parked run",
      waiting.waits.length === 1 && waiting.waits[0]!.requiredAuthority.length > 0,
      `${waiting.waits.length} open decision(s)`,
    );

    await refuses(
      "an approval naming a hash that no longer matches is refused",
      "stale_version",
      () =>
        command("stage.approve", projectId, {
          runId: run.id,
          versions: [
            { artifactId: node.artifactId, versionId: node.nodeId, contentHash: "0".repeat(64) },
          ],
        }),
    );
  }

  const advanced = await command("stage.approve", projectId, {
    runId: run.id,
    versions: [{ artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash }],
  });
  check(`stage ${stage} approved and advanced to ${stage + 1}`, advanced.stage === stage + 1);

  if (stage === 1) {
    const closed = await projectDetail(projectId, ACTOR.principalId);
    check("approving takes the decision out of the queue", closed.waits.length === 0);
  }
}

// --- Stage 5: audience quorum ---
{
  const detail = await projectDetail(projectId, ACTOR.principalId);
  const run = detail.current!;
  const node = await produce(5, projectId, run.id);
  const version = {
    artifactId: node.artifactId,
    versionId: node.nodeId,
    contentHash: node.contentHash,
  };
  await command("stage.submit", projectId, { runId: run.id, versions: [version] });

  await refuses(
    "stage 5 cannot be approved before the audience quorum is recorded",
    "quorum_not_met",
    () => command("stage.approve", projectId, { runId: run.id, versions: [version] }),
  );

  await command("audience.decide", projectId, {
    runId: run.id,
    audienceName: "Project owner",
    decision: "proceed",
    versions: [version],
  });

  const stillFive = await projectDetail(projectId, ACTOR.principalId);
  check(
    "audience.decide records without transitioning the stage",
    stillFive.current!.stage === 5 && stillFive.current!.state === "waiting_approval",
  );

  // The collapsed "Approve and continue" submits and approves in one; a
  // stage already under review — stage 5's packages go with the first
  // decision — has nothing left to submit, and the approval alone must run.
  const { submitAndApprove } = await import("../apps/hub/src/engine.js");
  const advanced = await submitAndApprove({
    actor: ACTOR,
    projectId,
    runId: run.id,
    versions: [version],
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    expectedRevision: (await projectDetail(projectId, ACTOR.principalId)).project.revision,
  });
  check("stage 5 advances once the quorum is met, through the one-step approval of a stage already under review", advanced.stage === 6, `stage ${advanced.stage}`);
}

// --- Stage 5, separately: parallel audience packages and a blocking reject ---
{
  const many = await createProject({
    title: "Smoke: four audiences",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [
        { name: "Project owner", role: "project_owner" },
        { name: "Security", role: "audience_member" },
      ],
      audienceQuorum: 2,
      allowExternalProviders: false,
    },
  });

  // Two packages of the same kind on one branch must stand side by side.
  const first = await writeArtifact(
    {
      projectId: many.projectId,
      kind: "audience_package",
      variant: "Project owner",
      title: "Package for the project owner",
      content: "# For the owner",
      mediaType: "text/markdown",
      sourceVersionIds: [],
      provenance: { producer: "human" },
    },
    ACTOR,
  );
  const second = await writeArtifact(
    {
      projectId: many.projectId,
      kind: "audience_package",
      variant: "Security",
      title: "Package for security",
      content: "# For security",
      mediaType: "text/markdown",
      sourceVersionIds: [],
      provenance: { producer: "human" },
    },
    ACTOR,
  );
  check(
    "two audience packages coexist rather than superseding each other",
    first.artifactId !== second.artifactId && first.version === 1 && second.version === 1,
  );

  // Walk to stage 5.
  let currentRun = (await projectDetail(many.projectId, ACTOR.principalId)).current!;
  for (const stage of [1, 2, 3, 4] as Stage[]) {
    const node = await produce(stage, many.projectId, currentRun.id);
    const stageVersion = {
      artifactId: node.artifactId,
      versionId: node.nodeId,
      contentHash: node.contentHash,
    };
    await command("stage.submit", many.projectId, {
      runId: currentRun.id,
      versions: [stageVersion],
    });
    const next = await command("stage.approve", many.projectId, {
      runId: currentRun.id,
      versions: [stageVersion],
    });
    currentRun = (await projectDetail(many.projectId, ACTOR.principalId)).runs.find((entry) => entry.id === next.runId)!;
  }

  const ownerVersion = {
    artifactId: first.artifactId,
    versionId: first.nodeId,
    contentHash: first.contentHash,
  };
  const securityVersion = {
    artifactId: second.artifactId,
    versionId: second.nodeId,
    contentHash: second.contentHash,
  };
  await command("stage.submit", many.projectId, {
    runId: currentRun.id,
    versions: [ownerVersion, securityVersion],
  });

  await command("audience.decide", many.projectId, {
    runId: currentRun.id,
    audienceName: "Project owner",
    decision: "proceed",
    versions: [ownerVersion],
  });

  await refuses(
    "a partial quorum does not advance stage 5",
    "quorum_not_met",
    () =>
      command("stage.approve", many.projectId, {
        runId: currentRun.id,
        versions: [ownerVersion, securityVersion],
      }),
  );

  await command("audience.decide", many.projectId, {
    runId: currentRun.id,
    audienceName: "Security",
    decision: "reject",
    versions: [securityVersion],
  });

  await refuses(
    "one audience rejecting blocks approval even at full quorum",
    "quorum_not_met",
    () =>
      command("stage.approve", many.projectId, {
        runId: currentRun.id,
        versions: [ownerVersion, securityVersion],
      }),
  );

  await refuses(
    "one audience cannot record a second decision",
    "conflict",
    () =>
      command("audience.decide", many.projectId, {
        runId: currentRun.id,
        audienceName: "Security",
        decision: "proceed",
        versions: [securityVersion],
      }),
  );
}

// --- Stage 6: the requirements and the plan, approved together ---
{
  const detail = await projectDetail(projectId, ACTOR.principalId);
  const run = detail.current!;
  const requirements = await writeArtifact(
    {
      projectId,
      kind: "product_requirements",
      title: "Stage 6 requirements",
      content: `# Requirements\n\nRecorded by the loop smoke at ${new Date().toISOString()}.`,
      mediaType: "text/markdown",
      sourceVersionIds: [],
      provenance: { producer: "human", runId: run.id },
    },
    ACTOR,
  );
  const node = await produce(6, projectId, run.id);
  const versions = [node, requirements].map((entry) => ({
    artifactId: entry.artifactId,
    versionId: entry.nodeId,
    contentHash: entry.contentHash,
  }));
  await command("stage.submit", projectId, { runId: run.id, versions });
  const advanced = await command("stage.approve", projectId, { runId: run.id, versions });
  check("stage 6 advances to cost approval", advanced.stage === 7);
}

// --- Stage 7: the cost-approval / freeze interlock ---
let buildRunId = "";
{
  const detail = await projectDetail(projectId, ACTOR.principalId);
  const run = detail.current!;
  const node = await produce(7, projectId, run.id);
  const version = {
    artifactId: node.artifactId,
    versionId: node.nodeId,
    contentHash: node.contentHash,
  };
  await command("stage.submit", projectId, { runId: run.id, versions: [version] });

  await refuses(
    "stage.approve is refused at stage 7 — cost.approve is the only route",
    "forbidden",
    () => command("stage.approve", projectId, { runId: run.id, versions: [version] }),
  );

  await refuses(
    "build.freeze is refused before cost.approve",
    "wrong_state",
    () =>
      command("build.freeze", projectId, {
        runId: run.id,
        versions: [version],
        placement: "local",
        targets: ["local"],
      }),
  );

  const costed = await command("cost.approve", projectId, {
    runId: run.id,
    versions: [version],
    forecastUsd: 1200,
    assumptions: ["Recorded by the loop smoke."],
  });
  check(
    "cost.approve records without advancing the stage",
    costed.stage === 7 && costed.state === "cost_approved",
  );

  const frozen = await command("build.freeze", projectId, {
    runId: run.id,
    versions: [version],
    placement: "local",
    targets: ["local"],
  });
  check("build.freeze queues a build run at stage 8", frozen.stage === 8 && frozen.state === "queued");
  buildRunId = frozen.runId;

  const afterFreeze = await projectDetail(projectId, ACTOR.principalId);
  const stage7 = afterFreeze.runs.find((entry) => entry.id === run.id);
  check(
    "the stage-7 run is terminal after the freeze",
    stage7?.state === "approved_frozen",
    `state=${stage7?.state}`,
  );

  await refuses(
    "re-freezing the same run source is forbidden",
    "forbidden",
    () =>
      command("build.freeze", projectId, {
        runId: run.id,
        versions: [version],
        placement: "local",
        targets: ["local"],
      }),
  );
}

// --- Stage 8: what the worker's outcome means for the run ---
{
  const bin = await mkdtemp(join(tmpdir(), "solutions-builder-worker-"));

  // A worker that is not there — the same, to the bridge, as one the OS kills
  // on launch. The bridge's probe fails, and the run has to say so on the
  // ledger rather than sit under "running" beside a terminal result.
  process.env.SOLUTIONS_BUILDER_WORKER_BIN = join(bin, "no-such-worker");
  const first = await startBuildAttempt({ actor: ACTOR, projectId, runId: buildRunId });
  check("starting an attempt moves the queued run to running", first.run.state === "running");
  const outcome = await first.attempt;
  check(
    "an unavailable worker reports itself so, with no exit status",
    outcome?.available === false && outcome.exitStatus === null,
  );
  const afterFirst = await projectDetail(projectId, ACTOR.principalId);
  const failedRun = afterFirst.runs.find((entry) => entry.id === buildRunId);
  check(
    "an unavailable worker fails the run on the ledger, with the reason",
    failedRun?.state === "failed" && (failedRun.terminalReason ?? "").includes("unavailable"),
    `state=${failedRun?.state} reason=${failedRun?.terminalReason ?? "none"}`,
  );
  check("the failed attempt is the project's current run", afterFirst.current?.id === buildRunId);
  const recorded = await buildEvents(projectId, buildRunId);
  check(
    "the bridge's final event records that the worker was unavailable",
    recorded.some(
      (event) => event.type === "bridge.final" && (event.payload as { available?: boolean }).available === false,
    ),
  );

  // A worker that stays up can be cancelled: the ledger decides, then the
  // process is stopped, and the run stays cancelled once the worker ends.
  const slow = join(bin, "slow-worker");
  await writeFile(
    slow,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;',
      // What Corbits Code does after a turn: the placed hook, the turn on stdin.
      "  exec) echo \"working on it\"; printf '%s' '"
        + JSON.stringify({ turnIndex: 0, durationMs: 1500, toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "plan.md" } }], toolResults: [{ callId: "c1", content: "ok" }] })
        + "' | sh .corbits/hooks/solutions-builder-turns.sh postTurn; exec sleep 60 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(slow, 0o755);
  process.env.SOLUTIONS_BUILDER_WORKER_BIN = slow;
  const requeued = await command("build.start_attempt", projectId, { runId: buildRunId });
  check(
    "starting from a failed run queues a new attempt rather than running one",
    requeued.state === "queued" && requeued.runId !== buildRunId,
  );
  const second = await startBuildAttempt({ actor: ACTOR, projectId, runId: requeued.runId });
  check("the new attempt runs", second.run.state === "running");
  // The worker's output reaches a watcher as it is written, and the host
  // says when the worker started, so a window can count up from it.
  const watched: string[] = [];
  let ended = false;
  const stopWatching = subscribeBuildOutput(requeued.runId, (event) => {
    if (event.type === "text") watched.push(event.text);
    else ended = true;
  });
  for (let waited = 0; waited < 50 && !liveBuild(requeued.runId)?.transcript.includes("working on it"); waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const live = liveBuild(requeued.runId);
  check(
    "a running attempt's output is kept as the worker writes it",
    live !== null && live.transcript.includes("working on it") && Number.isFinite(Date.parse(live.startedAt)),
    live ? `startedAt=${live.startedAt} transcript=${JSON.stringify(live.transcript)}` : "no live attempt",
  );
  check("and reaches a watcher as it lands", watched.join("").includes("working on it"));
  for (let waited = 0; waited < 50 && !liveBuild(requeued.runId)?.transcript.includes("read_file"); waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const reported = liveBuild(requeued.runId)?.transcript ?? "";
  check(
    "a turn the worker reports through the placed hook is said in the transcript, with its tool call",
    reported.includes("── turn 1 · 1 tool call · 1.5s") && reported.includes('read_file {"path":"plan.md"}'),
    JSON.stringify(reported),
  );
  const cancelled = await command("build.cancel", projectId, { runId: requeued.runId, reason: "smoke" });
  check("build.cancel terminalizes the running attempt", cancelled.state === "cancelled");
  check("the cancel reaches the worker process", abortBuildAttempt(requeued.runId));
  const outcomeOfSecond = await second.attempt;
  check("the worker ends once cancelled", outcomeOfSecond !== null && outcomeOfSecond.exitStatus !== 0);
  check(
    "the outcome counts what the worker reported",
    outcomeOfSecond?.turns === 1 && outcomeOfSecond.toolCalls === 1 && typeof outcomeOfSecond.turnLog === "string",
    `turns=${outcomeOfSecond?.turns} toolCalls=${outcomeOfSecond?.toolCalls}`,
  );
  check("a watcher is told the attempt ended, and nothing is live for it", ended && liveBuild(requeued.runId) === null);
  stopWatching();
  const afterCancel = await projectDetail(projectId, ACTOR.principalId);
  check(
    "a cancelled run stays cancelled after its worker ends",
    afterCancel.runs.find((entry) => entry.id === requeued.runId)?.state === "cancelled",
  );

  // A worker that ran and exited non-zero — a build that finished and then
  // crashed on the way out looks exactly like this — is not a failed build.
  // The run stays running with the worker's result beside it, and the person
  // decides what it was.
  const crashing = join(bin, "crashing-worker");
  await writeFile(
    crashing,
    ["#!/bin/sh", 'case "$1" in', '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;', '  exec) echo "built everything"; echo "half the work" > built.txt; echo "teardown failed" >&2; exit 1 ;;', "esac", ""].join("\n"),
  );
  await chmod(crashing, 0o755);
  process.env.SOLUTIONS_BUILDER_WORKER_BIN = crashing;
  const third = await command("build.start_attempt", projectId, { runId: requeued.runId });
  check("starting from a cancelled run queues a new attempt", third.state === "queued");
  const crashed = await startBuildAttempt({ actor: ACTOR, projectId, runId: third.runId });
  const crashedOutcome = await crashed.attempt;
  const afterCrash = await projectDetail(projectId, ACTOR.principalId);
  check(
    "a worker that ran and exited non-zero leaves the run running, for the person to judge",
    crashedOutcome?.exitStatus === 1 && afterCrash.runs.find((entry) => entry.id === third.runId)?.state === "running",
    `exit=${crashedOutcome?.exitStatus} state=${afterCrash.runs.find((entry) => entry.id === third.runId)?.state}`,
  );
  check(
    "with the worker's final output and error tail recorded",
    (await buildEvents(projectId, third.runId)).some((event) => {
      const payload = event.payload as { finalText?: string; stderrTail?: string };
      return event.type === "bridge.final" && payload.finalText?.includes("built everything") === true && payload.stderrTail?.includes("teardown failed") === true;
    }),
  );
  const judged = await command("build.fail", projectId, { runId: third.runId, reason: "the person read the output and said so" });
  check("the person can then fail it through the ledger", judged.state === "failed");

  // Trying again can continue from that attempt's work: its workspace is
  // copied into the new attempt's, and the worker is told it is there.
  const continuing = join(bin, "continuing-worker");
  await writeFile(
    continuing,
    ["#!/bin/sh", 'case "$1" in', '  --help) echo "usage: worker exec <prompt>"; exit 0 ;;', '  exec) if [ -f built.txt ]; then echo "found previous work: $(cat built.txt)"; else echo "nothing here"; fi; case "$2" in *"Continue from it"*) echo "told to continue" ;; esac; exit 0 ;;', "esac", ""].join("\n"),
  );
  await chmod(continuing, 0o755);
  process.env.SOLUTIONS_BUILDER_WORKER_BIN = continuing;
  const fourth = await command("build.start_attempt", projectId, { runId: third.runId });
  check("starting from a failed run queues a new attempt", fourth.state === "queued");
  const continued = await startBuildAttempt({ actor: ACTOR, projectId, runId: fourth.runId, continueFromRunId: third.runId });
  const continuedOutcome = await continued.attempt;
  check(
    "a continued attempt starts from the earlier attempt's work, and is told so",
    continuedOutcome?.finalText.includes("found previous work: half the work") === true &&
      continuedOutcome.finalText.includes("told to continue") &&
      continuedOutcome.continuedFrom === third.runId,
    JSON.stringify(continuedOutcome?.finalText),
  );
  check(
    "in a workspace of its own, not the earlier attempt's",
    (await workspaceFor(fourth.runId)) !== (await workspaceFor(third.runId)) &&
      (await Bun.file(join(await workspaceFor(fourth.runId), "built.txt")).exists()),
  );
  await refuses(
    "continuing from a run that is not a build attempt of this project is refused",
    "validation_failed",
    () => startBuildAttempt({ actor: ACTOR, projectId, runId: fourth.runId, continueFromRunId: "run_not_here" }),
  );
  delete process.env.SOLUTIONS_BUILDER_WORKER_BIN;
  // The continued attempt ended with exit 0 and is the person's to judge;
  // judged failed here so the rest of the smoke has a queued attempt to
  // drive by hand, through the ledger alone.
  await command("build.fail", projectId, { runId: fourth.runId, reason: "the smoke moves on" });
  const fifth = await command("build.start_attempt", projectId, { runId: fourth.runId });
  check("starting from the judged run queues the attempt the smoke drives by hand", fifth.state === "queued");
  buildRunId = fifth.runId;
}

// --- Stage 8: attempt, a human question, and evidence ---
{
  const running = await command("build.start_attempt", projectId, { runId: buildRunId });
  check("build.start_attempt moves the queued run to running", running.state === "running");

  await refuses(
    "a human cannot raise a worker's wait-for-human request",
    "not_authorized",
    () =>
      command("build.wait_for_human", projectId, {
        runId: buildRunId,
        kind: "permission",
        prompt: "Not a worker.",
      }),
  );

  await command(
    "build.wait_for_human",
    projectId,
    {
      runId: buildRunId,
      kind: "permission",
      prompt: "The build wants to install a dependency. Approve?",
    },
    HOST_ACTOR,
  );
  const waiting = await projectDetail(projectId, ACTOR.principalId);
  check(
    "a worker question puts a stage 8 decision in the queue",
    waiting.waits.length === 1 && waiting.current!.state === "waiting_human",
  );

  const answered = await command("build.answer", projectId, {
    runId: buildRunId,
    questionId: waiting.questions[0]!.id,
    answer: "Approved for this attempt only.",
  });
  check(
    "build.answer resumes the same attempt without creating a run",
    answered.runId === buildRunId && answered.state === "running",
  );

  await refuses(
    "build.resume is refused when no checkpoint was verified",
    "wrong_state",
    () => command("build.resume", projectId, { runId: buildRunId }),
  );

  // The manifest names bytes that are not in the workspace yet, so the
  // verification recorded with it is incomplete and stage 9 must refuse.
  const accepted = await command("build.accept_evidence", projectId, {
    runId: buildRunId,
    versions: [],
    descriptors: [
      { category: "source", path: "dist/chess.app", sha256: DELIVERED_SHA, sizeBytes: DELIVERED_BYTES.byteLength, mediaType: "application/octet-stream", access: "local", required: true },
      { category: "docs", path: "https://example.invalid/README", sha256: "b".repeat(64), sizeBytes: 12, mediaType: "text/markdown", access: "remote", required: false },
    ],
    verification: { requiredChecks: "recorded by the loop smoke" },
    actualCost: 12.5,
  });
  check("accepting evidence opens delivery review at stage 9", accepted.stage === 9);
  const opened = await openDecisionFor(projectId);
  check(
    "the stage 9 decision names the missing byte",
    (opened?.blockers ?? "").includes("missing: dist/chess.app"),
    opened?.blockers ?? "no blockers",
  );
}

// --- Stage 9: delivery ---
{
  const detail = await projectDetail(projectId, ACTOR.principalId);
  const run = detail.current!;
  const acceptDelivery = () =>
    command("delivery.accept", projectId, {
      runId: run.id,
      manifestVersion: { artifactId: "-", versionId: "-", contentHash: "0".repeat(64) },
    });
  await refuses("delivery.accept is refused while a required byte is missing", "transition_refused", acceptDelivery);
  await mkdir(join(await workspaceFor(buildRunId), "dist"), { recursive: true });
  await writeFile(join(await workspaceFor(buildRunId), "dist", "chess.app"), Buffer.from("not the bytes"));
  await refuses("delivery.accept is refused while a required byte does not match its hash", "transition_refused", acceptDelivery);
  await writeFile(join(await workspaceFor(buildRunId), "dist", "chess.app"), DELIVERED_BYTES);
  const delivered = await acceptDelivery();
  check("delivery.accept completes the project once the bytes match", delivered.state === "delivered");

  const final = await projectDetail(projectId, ACTOR.principalId);
  check(
    "the delivery manifest is recorded and accepted",
    final.manifests.length === 1 && final.manifests[0]!.acceptedAt !== null,
  );
  // Seven stage runs (1-7), five build runs (one failed for want of a worker,
  // one canceled, one failed by the person, one continued from it and judged,
  // one accepted), one delivery run. Nothing is deleted or reused along the way.
  check(
    "every run is retained in history",
    final.runs.length === 13,
    `${final.runs.length} runs`,
  );

  const archived = await command("project.archive", projectId, { runId: run.id });
  check("a delivered project can be archived", archived.state === "archived");
}

// --- Backtracking, on a second project ---
{
  const second = await createProject({
    title: "Smoke: a project that gets routed back",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });
  const detail = await projectDetail(second.projectId, ACTOR.principalId);
  const run = detail.current!;
  const node = await produce(1, second.projectId, run.id);
  const version = {
    artifactId: node.artifactId,
    versionId: node.nodeId,
    contentHash: node.contentHash,
  };
  await command("stage.submit", second.projectId, { runId: run.id, versions: [version] });
  const advanced = await command("stage.approve", second.projectId, {
    runId: run.id,
    versions: [version],
  });

  const node2 = await produce(2, second.projectId, advanced.runId);
  await command("stage.submit", second.projectId, {
    runId: advanced.runId,
    versions: [
      { artifactId: node2.artifactId, versionId: node2.nodeId, contentHash: node2.contentHash },
    ],
  });
  const routed = await command("stage.reject", second.projectId, {
    runId: advanced.runId,
    targetStage: 1,
    reason: "The problem statement is still too vague to bound.",
  });
  check("rejecting routes back to the named earlier stage", routed.stage === 1 && routed.state === "backtracked");

  const resumed = await command("stage.select_route", second.projectId, { runId: routed.runId });
  check("selecting the recorded route reopens the target stage", resumed.stage === 1 && resumed.state === "in_progress");

  const history = await projectDetail(second.projectId, ACTOR.principalId);
  // Stage 1, stage 2, the terminalised run's backtrack record, and the run
  // the selected route opened. The rejected work is superseded, not removed.
  check(
    "backtracking retains history rather than destroying it",
    history.runs.length === 4 && history.flags.length === 1,
    `${history.runs.length} runs, ${history.flags.length} flag(s)`,
  );
}

// --- Idempotency ---
{
  const third = await createProject({
    title: "Smoke: replay",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });
  const detail = await projectDetail(third.projectId, ACTOR.principalId);
  const run = detail.current!;
  const node = await produce(1, third.projectId, run.id);
  const key = newId.command();
  const payload = {
    runId: run.id,
    versions: [
      { artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash },
    ],
  };
  const first = await execute({
    type: "stage.submit",
    actor: ACTOR,
    projectId: third.projectId,
    idempotencyKey: key,
    correlationId: newId.correlation(),
    payload,
  });
  const replay = await execute({
    type: "stage.submit",
    actor: ACTOR,
    projectId: third.projectId,
    idempotencyKey: key,
    correlationId: newId.correlation(),
    payload,
  });
  check(
    "a replayed command returns the first result without a second effect",
    replay.replayed === true && replay.runId === first.runId,
  );

  const waits = await projectDetail(third.projectId, ACTOR.principalId);
  check("the replay did not produce a second decision", waits.waits.length === 1);

  // The retry that arrives while the original is still in flight. Sequential
  // replay is the easy half; this is the one that used to hand the loser the
  // guard's refusal against a row the winner had already moved.
  const racer = await createProject({
    title: "Smoke: concurrent replay",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });
  const concurrentRun = (await projectDetail(racer.projectId, ACTOR.principalId)).current;
  if (concurrentRun) {
    const concurrentNode = await produce(1, racer.projectId, concurrentRun.id);
    const raced = newId.command();
    const envelope = {
      type: "stage.submit" as const,
      actor: ACTOR,
      projectId: racer.projectId,
      idempotencyKey: raced,
      correlationId: newId.correlation(),
      payload: {
        runId: concurrentRun.id,
        versions: [
          {
            artifactId: concurrentNode.artifactId,
            versionId: concurrentNode.nodeId,
            contentHash: concurrentNode.contentHash,
          },
        ],
      },
    };
    const [left, right] = await Promise.allSettled([execute(envelope), execute(envelope)]);
    const settled = [left, right];
    check(
      "a concurrent retry replays rather than being refused",
      settled.every((entry) => entry.status === "fulfilled"),
      settled
        .map((entry) => (entry.status === "fulfilled" ? "ok" : String(entry.reason)))
        .join(" / "),
    );
    check(
      "and exactly one of the two produced the effect",
      settled.filter((entry) => entry.status === "fulfilled" && !entry.value.replayed).length === 1,
    );
  }
}

// §13: deleting a project tombstones it. The rows stay; the project stops
// being readable. Nothing a person wrote is removed.
{
  const doomed = await createProject({
    title: "Smoke: delete",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });
  const before = await listProjects();
  const deleted = await command("project.delete", doomed.projectId, {});
  check("project.delete commits", deleted.transitionId === "project.delete");
  const after = await listProjects();
  check(
    "the deleted project stops being listed",
    before.some((entry) => entry.id === doomed.projectId) &&
      !after.some((entry) => entry.id === doomed.projectId),
    `${before.length} then ${after.length}`,
  );
  let refused = "";
  await projectDetail(doomed.projectId, ACTOR.principalId).catch((cause: unknown) => {
    refused = cause instanceof Error ? cause.message : String(cause);
  });
  check("and reading it is refused rather than answered", refused.length > 0, refused);
}

// §6: optimistic concurrency. Two people on the same stage, one acting on what
// the other has already changed, is what this exists for — and without it the
// failure is silent, because both commands are individually legal.
{
  const fresh = await createProject({
    title: "Concurrency",
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [{ name: "Project owner", role: "project_owner" }],
      audienceQuorum: 1,
      allowExternalProviders: false,
    },
    owner: ACTOR,
  });
  const written = await produce(1, fresh.projectId, fresh.runId);
  const brief = [
    {
      artifactId: written.artifactId,
      versionId: written.nodeId,
      contentHash: written.contentHash,
    },
  ];

  const before = await projectDetail(fresh.projectId, ACTOR.principalId);
  const staleRevision = before.project.revision;

  await execute({
    type: "stage.submit",
    actor: ACTOR,
    projectId: fresh.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    expectedRevision: staleRevision,
    payload: { runId: fresh.runId, versions: brief },
  });

  const after = await projectDetail(fresh.projectId, ACTOR.principalId);
  check(
    "a command moves the project revision",
    after.project.revision > staleRevision,
    `${staleRevision} to ${after.project.revision}`,
  );

  let refused = "";
  try {
    await execute({
      type: "stage.approve",
      actor: ACTOR,
      projectId: fresh.projectId,
      idempotencyKey: newId.command(),
      correlationId: newId.correlation(),
      // The revision this caller last read, which is now behind.
      expectedRevision: staleRevision,
      payload: { runId: fresh.runId, versions: brief },
    });
  } catch (cause) {
    refused = cause instanceof Error ? cause.message : String(cause);
  }
  check("a stale decision is refused", refused.includes("has changed since you loaded it"), refused.slice(0, 70));

  const stillWaiting = await projectDetail(fresh.projectId, ACTOR.principalId);
  check(
    "and changes nothing",
    stillWaiting.current?.state === "waiting_approval",
    String(stillWaiting.current?.state),
  );
}

// §6: authority is per project, not per tenant. A project is its own tenant,
// so a principal granted every authority in the workspace holds nothing on a
// project they were never put on. A stranger with no grants would fail this
// for the wrong reason, so the stranger here is granted everything first.
{
  const other = { principalId: "p_other_owner", displayName: "Someone else" };
  await ensureUserPrincipal(tenantId(), other.principalId);
  for (const role of await listRoles()) {
    if ((AUTHORITIES as readonly string[]).includes(role.name) && role.name !== "system") {
      await assignRole(other.principalId, role.id);
    }
  }
  const mine = await createProject({
    title: "A project the stranger is not on",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });
  const detail = await projectDetail(mine.projectId, ACTOR.principalId);
  const run = detail.current!;
  const node = await produce(1, mine.projectId, run.id);

  const holds = await evaluate(other.principalId, "authority:project_owner", "hold");
  check("the stranger does hold these authorities workspace-wide", holds === "allow", holds);

  let refused = "";
  await execute({
    type: "stage.submit",
    actor: other,
    projectId: mine.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload: {
      runId: run.id,
      versions: [
        { artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash },
      ],
    },
  }).catch((cause: unknown) => {
    refused = cause instanceof HostError ? cause.code : String(cause);
  });
  check(
    "but holds none of them on a project they are not on",
    refused === "not_authorized" || refused === "transition_refused",
    refused || "the command was allowed",
  );

  const still = await projectDetail(mine.projectId, ACTOR.principalId);
  check("and the stage did not move", still.current?.state === "in_progress", String(still.current?.state));
}

// The solo-approver collapse: a workspace with exactly one holder of a
// stage's approval authority gets one action, not a submit-to-yourself.
// `soloApproval` is derived from a real platform grant, not merely a
// `participant` row, so the second half of this proves the flag by adding a
// genuine second holder — not just another name on the project.
{
  const solo = await createProject({
    title: "Smoke: solo approver",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 10,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });
  const soloDetail = await projectDetail(solo.projectId, ACTOR.principalId);
  check("a solo project reports soloApproval true", soloDetail.soloApproval === true);

  const run = soloDetail.current!;
  const node = await produce(1, solo.projectId, run.id);
  const outcome = await submitAndApprove({
    actor: ACTOR,
    projectId: solo.projectId,
    runId: run.id,
    versions: [
      { artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash },
    ],
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
  });
  check(
    "the one-action command carries a solo project from in_progress to approved in a single call",
    outcome.stage === 2 && outcome.state === "in_progress",
    `stage=${outcome.stage} state=${outcome.state}`,
  );

  // A genuine second holder: a real `principal` in the project tenant with
  // the `project_owner` role there, which is what a participant is now.
  const second = "p_second_owner";
  await ensureUserPrincipal(solo.projectId, second);
  const ownerRole = (await listRoles(solo.projectId)).find((role) => role.name === "project_owner");
  if (!ownerRole) throw new Error("the project tenant has no project_owner role");
  await assignRole(second, ownerRole.id, solo.projectId);
  const afterSecond = await projectDetail(solo.projectId, ACTOR.principalId);
  check(
    "a project with a second participant holding the authority reports false",
    afterSecond.soloApproval === false,
    String(afterSecond.soloApproval),
  );
}

// --- A restart still finds the decision ---
// The executor's run map is process memory. Recovery reads the position back
// from what is durable, and the decision waiting on the person has to come
// back with it — on its own project, so the history counts above stay exact.
{
  const fresh = await createProject({
    title: "Smoke: recovered after a restart",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 500,
      audiences: [{ name: "Project owner", role: "project_owner" }],
      audienceQuorum: 1,
      allowExternalProviders: false,
    },
  });
  const detail = await projectDetail(fresh.projectId, ACTOR.principalId);
  const node = await produce(1, fresh.projectId, detail.current!.id);
  await command("stage.submit", fresh.projectId, {
    runId: detail.current!.id,
    versions: [{ artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash }],
  });
  // Nothing about the run is in process memory: the same read a fresh host
  // makes folds the ledger thread and finds the parked stage.
  const recovered = await activeRun(fresh.projectId);
  check(
    "a restart still finds the stage waiting on the decision",
    recovered?.state === "waiting_approval" && recovered.stage === 1,
    `${recovered?.state} at stage ${recovered?.stage}`,
  );
}

await host.close();

// The run follows the ledger. A run behind it is walked forward with the
// signals a person would have sent; one ahead of it, or inside the build, is
// reported rather than driven.
{
  const step = (stage: number, at: "round" | "gate", ledgerStage: number, state: "in_progress" | "waiting_approval") =>
    alignmentStep({ stage: stage as Stage, at }, { stage: ledgerStage as Stage, state });
  check("a run parked where the ledger stands is aligned", step(4, "round", 4, "in_progress").kind === "aligned");
  check("a fresh run at stage 1 is sent past its round with a submit", JSON.stringify(step(1, "round", 5, "in_progress")) === JSON.stringify({ kind: "deliver", command: "stage.submit" }));
  check("a gate below the ledger is left with an approval", JSON.stringify(step(2, "gate", 5, "in_progress")) === JSON.stringify({ kind: "deliver", command: "stage.approve" }));
  check("stage 7's gate is left with the cost approval", JSON.stringify(step(7, "gate", 8, "in_progress")) === JSON.stringify({ kind: "deliver", command: "cost.approve" }));
  check("a ledger waiting on approval wants the run at that stage's gate", step(3, "round", 3, "waiting_approval").kind === "deliver" && step(3, "gate", 3, "waiting_approval").kind === "aligned");
  check("a run ahead of the ledger is not rewound", step(6, "round", 5, "in_progress").kind === "ahead" && step(5, "gate", 5, "in_progress").kind === "ahead");
  check("a run is never driven through the build stage", step(8, "round", 9, "in_progress").kind === "unsupported");
  check(
    "signal names read back as positions",
    positionOfSignal(2 as Stage, roundSignal(2 as Stage))?.at === "round" &&
      positionOfSignal(2 as Stage, approveSignal(2 as Stage))?.at === "gate" &&
      positionOfSignal(2 as Stage, exhaustedSignal(2 as Stage))?.at === "gate" &&
      positionOfSignal(2 as Stage, "something.else") === null,
  );
}

const failed = checks.filter((entry) => !entry.ok);

console.log(`\nLoop smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
