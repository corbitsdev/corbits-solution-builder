/**
 * Sidecar smoke: the embedded hub places Interchange's own sidecar, and the
 * project lifecycle deploys through the hub as a code-sourced workflow.
 *
 * Serves the hub on a loopback port the way the host does (sidecars dial back
 * in over a WebSocket), installs the package, connects a stub provider so a
 * catalog offering exists, then asks the hub to deploy the rendered lifecycle.
 * The hub spawns a probe sidecar through the process provisioner, evaluates
 * the source, freezes a definition and creates the anchor run. Every step is
 * asserted on the hub's own rows.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

const dataDir = await mkdtemp(join(tmpdir(), "sb-sidecar-"));
process.env["SOLUTIONS_BUILDER_DATA_DIR"] = dataDir;

const { openDatabase } = await import("../apps/hub/src/db.js");
const { prepareDatabase } = await import("../apps/hub/src/migrate.js");
const { hub, hubWebSocket, mountHub, setHostPort } = await import("../apps/hub/src/hub-mount.js");
const { install, ensureLifecycleDeployment, LIFECYCLE_ASSET_NAME } = await import("./host-install.js");
const { connectProvider } = await import("../apps/hub/src/providers.js");
const { assets } = await import("../apps/hub/src/hub-client.js");
const { kitSeed } = await import("@solutions-builder/app/seed-kit");

const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const SECRET = "sk-stub-do-not-store-me-anywhere";
/** Every chat completion the stub answered: the agent step ran under the sidecar. */
const completions: { model: string; messages: unknown[]; maxTokens?: number | undefined }[] = [];
/** Every request the stub saw, for diagnosis when the agent never arrives. */
const requests: string[] = [];

/**
 * A two-question brief, in the exact shape `questionsIn` parses: each
 * question a top-level bullet, its likely answers the `- Option:` bullets
 * that follow it.
 */
const BRAINSTORMER_REPLY = `## In short
Getting started. I will ask a couple of questions, then draft your brief.

## What I need from you
- Which outbound channel should this brief center on first, meaning the one the process is built around? It decides where the rest of the brief points.
- Option: Cold email
- Option: Cold calling
- How many leads per week should the process handle, meaning the target weekly volume the brief should design around? It sets the scale of what gets built.
- Option: Dozens
- Option: Hundreds`;

const EVALUATOR_REPLY = `Verdict: not yet
- Success criteria are aspirations.`;

const BUILD_REPLY = "## In short\n- Build attempt acknowledged.";

/** The stakeholder whose package the stub answers with nothing, while set. */
let packageToFail: string | null = null;
/** When set, every stage round's call is refused: the failure a person sees when a provider goes wrong mid-project. */
let refuseRounds = false;
/** Every illustration the stub was asked to draw. */
const imagePrompts: string[] = [];
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Which canned reply a completion gets, told apart by a phrase distinctive to each role's own system prompt; null refuses the call. */
function replyFor(messages: unknown[]): string | null {
  const text = JSON.stringify(messages);
  if (refuseRounds) return null;
  if (text.includes("You are the Brainstormer at stage 1.")) return BRAINSTORMER_REPLY;
  if (text.includes("You are the Brief evaluator inside Solutions Builder")) return EVALUATOR_REPLY;
  if (text.includes("You are the art director for a short business presentation.")) {
    // The deck as the host sent it: the cover and the first slide get a
    // picture, the second is left alone.
    return JSON.stringify({
      cover: { illustrate: true, subject: "A maintainer at a desk with a tall stack of paper, one sheet lifted to the light." },
      slides: [
        { index: 0, illustrate: true, subject: "A Monday calendar page with a heavy toolbox on it." },
        { index: 1, illustrate: false },
      ],
    });
  }
  if (text.includes("You are the Presentation creator at stage 5.")) {
    const audience = /Prepare the package for one audience only: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "?";
    // A refusal, not an empty reply: an assistant turn with no text leaves
    // the agent step waiting for one, while a provider error fails the
    // step at once — the failure a person sees when a call goes wrong.
    if (audience === packageToFail) return null;
    return [
      `## Audience: ${audience}`,
      "",
      "### One-pager",
      "The Monday rebuild costs a day a week.",
      "",
      "### Deck outline",
      "",
      "1. **Problem: the Monday rebuild**  ",
      "   Cold outbound is rebuilt by hand every Monday. It costs a day a week [Brainstormer — stage 1].",
      "",
      "2. **Proposed solution: one process, kept**  ",
      "   The process is written once and run each week. Source: stage 3.",
      "",
      "### Decision request",
      "- Fund the next planning step.",
      "",
      "### Source versions",
      "- Brainstormer — stage 1",
    ].join("\n");
  }
  return BUILD_REPLY;
}

const stub = createServer((request, response) => {
  const authorized = (request.headers.authorization ?? "") === `Bearer ${SECRET}`;
  requests.push(`${request.method} ${request.url} ${authorized ? "authorized" : `unauthorized(${(request.headers.authorization ?? "").slice(0, 28)})`}`);
  if (!authorized) {
    response.writeHead(401).end("{}");
    return;
  }
  if (request.method === "POST" && /\/chat\/completions$/.test(request.url ?? "")) {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; messages: unknown[]; max_tokens?: number };
      completions.push({ model: parsed.model, messages: parsed.messages, maxTokens: parsed.max_tokens });
      const reply = replyFor(parsed.messages);
      if (reply === null) {
        // A 400 is fatal to the inference harness: no retry, the step fails now.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "stub: this package is refused", type: "invalid_request_error" } }));
        return;
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: reply }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
    return;
  }
  if (request.method === "POST" && /\/images\/generations$/.test(request.url ?? "")) {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      imagePrompts.push((JSON.parse(body) as { prompt: string }).prompt);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }));
    });
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "stub-large" }, { id: "stub-image" }] }));
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as { port: number }).port;

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!;
await probe.stop(true);
setHostPort(port);

const host = await openDatabase(join(dataDir, "pglite"));
await prepareDatabase(host);
await mountHub();
const { attachLiveDrafts } = await import("../apps/hub/src/live-drafts.js");
attachLiveDrafts();
const { attachRoundSpend } = await import("../apps/hub/src/round-spend.js");
attachRoundSpend();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  websocket: hubWebSocket,
  fetch: (request, bun) => hub().app.fetch(request, bun),
});

const rows = async (statement: ReturnType<typeof sql>) => {
  const out = (await host.db.execute(statement)) as { rows?: unknown[] } | unknown[];
  return (Array.isArray(out) ? out : out.rows ?? []) as Record<string, unknown>[];
};

try {
  await install();
  const skillAssets = await assets.list("skill");
  const skillKeys = kitSeed().skills.map((skill) => skill.key);
  check(
    "install writes one skill asset per kit skill",
    skillKeys.every((key) => skillAssets.some((asset) => asset.name === key)) && skillAssets.length === skillKeys.length,
    `${skillAssets.length} assets for ${skillKeys.length} skills`,
  );

  await install();
  const skillAssetsAgain = await assets.list("skill");
  check(
    "a second install creates no new skill assets",
    skillAssetsAgain.length === skillAssets.length,
    `${skillAssetsAgain.length} vs ${skillAssets.length}`,
  );

  const before = await ensureLifecycleDeployment();
  check("without an offering the lifecycle is not deployed", before.status === "no_offering", before.status);

  await connectProvider({
    providerId: "compatible",
    label: "Stub provider",
    kind: "api_key",
    secret: SECRET,
    baseUrl: `http://127.0.0.1:${stubPort}`,
  });

  const started = Date.now();
  let outcome: Awaited<ReturnType<typeof ensureLifecycleDeployment>> | { status: "failed"; detail: string };
  try {
    outcome = await ensureLifecycleDeployment();
  } catch (cause) {
    outcome = { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  check(
    "the hub deploys the rendered lifecycle through its own route",
    outcome.status === "deployed",
    outcome.status === "failed" ? outcome.detail.slice(0, 400) : `${outcome.status} in ${seconds}s`,
  );

  const asset = (await rows(sql`SELECT "id" FROM "public"."asset" WHERE "kind" = 'workflow' AND "name" = ${LIFECYCLE_ASSET_NAME}`))[0];
  check("the lifecycle source is a workflow asset", asset !== undefined);

  const probes = await rows(sql`SELECT "status", "failure_message" FROM "public"."workflow_probe"`);
  check(
    "the probe sidecar evaluated the source",
    probes.length > 0 && probes.every((row) => row.status !== "failed"),
    probes.map((row) => `${row.status}${row.failure_message ? `: ${row.failure_message}` : ""}`).join(" | ").slice(0, 300),
  );

  const definitions = asset
    ? await rows(sql`SELECT "id", "name", "status" FROM "public"."workflow_definition" WHERE "asset_id" = ${asset.id}`)
    : [];
  check("a frozen workflow_definition points at the asset", definitions.length > 0, definitions.map((row) => `${row.name}:${row.status}`).join(","));

  const runs = definitions.length
    ? await rows(sql`SELECT "id", "status" FROM "public"."workflow_run" WHERE "definition_id" = ${definitions[0]!.id}`)
    : [];
  check("an anchor workflow_run exists for the deployment", runs.length > 0, runs.map((row) => `${row.id}:${row.status}`).join(","));

  const waitStarted = Date.now();
  let allocations: Record<string, unknown>[] = [];
  while (Date.now() - waitStarted < 90_000) {
    allocations = await rows(sql`SELECT "status", "failure_message", "sidecar_id" FROM "public"."sidecar_allocation"`);
    if (allocations.some((row) => row.status === "allocated" && hub().sidecars.connected().some((id) => id === row.sidecar_id))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check(
    "the deployment sidecar is allocated and connected",
    allocations.some((row) => row.status === "allocated" && hub().sidecars.connected().some((id) => id === row.sidecar_id)),
    allocations.map((row) => `${row.status}${row.failure_message ? `: ${row.failure_message}` : ""}`).join(" | ").slice(0, 300),
  );

  if (outcome.status === "deployed") {
    const again = await ensureLifecycleDeployment();
    check("a second install is a read, not a second deployment", again.status === "current", again.status);
  }

  // A project runs on its own deployment. Creating one fires the run; the
  // first stage parks on the person, and a gate command lands as a signal.
  const { createProject } = await import("../apps/hub/src/projects.js");
  const { localActor, deploymentRuns, hubApi, tenantPath } = await import("../apps/hub/src/hub-client.js");
  const { projectExecutionStatus, deliverStageSignal, parkedSignalNames } = await import("../apps/hub/src/lifecycle-run.js");
  const projectTitle = "Smoke: runs on the hub";
  const project = await createProject({
    title: projectTitle,
    owner: { ...localActor(), displayName: "Smoke" },
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 500,
      audiences: [
        { name: "Project owner", role: "project_owner" },
        { name: "Finance lead", role: "budget_approver" },
      ],
      audienceQuorum: 1,
      allowExternalProviders: false,
    },
  });
  const parkedAt = Date.now();
  let status: Awaited<ReturnType<typeof projectExecutionStatus>> = null;
  while (Date.now() - parkedAt < 90_000) {
    status = await projectExecutionStatus(project.projectId).catch((cause: unknown) => {
      console.error("status read failed:", cause instanceof Error ? cause.message : String(cause));
      return null;
    });
    if (status?.parked) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check(
    "the project's run parks at stage 1 waiting on a person",
    status?.parked === true && status.stage === 1,
    status ? `${status.stepId} ${status.signalName ?? ""} in ${((Date.now() - parkedAt) / 1000).toFixed(1)}s` : "no run",
  );

  // The blob route: a well-formed but unknown sha 404s through the hub client
  // (proving the null-path holds end to end), and a malformed sha 400s at the
  // boundary. Reading a real blob needs an output over the 1 MiB inline
  // threshold, which this smoke does not produce.
  const unknownSha = "0".repeat(64);
  const missingBlob = await deploymentRuns.blob(project.runId, project.runId, unknownSha);
  check("a well-formed but unknown blob sha 404s through the hub", missingBlob === null, String(missingBlob));

  const malformedResponse = await hubApi(
    tenantPath(`/workflows/${project.runId}/runs/${project.runId}/blobs/not-a-sha`),
  );
  check("a malformed blob sha 400s", malformedResponse.status === 400, String(malformedResponse.status));
  if (status?.parked) {
    const { roundSignal, approveSignal, gateStepId, reviseStepId } = await import(
      "@solutions-builder/app/workflows/stage-loop"
    );
    const before = await parkedSignalNames(project.projectId);
    check("the stage 1 loop awaits its round signal", before.includes(roundSignal(1)), before.join(","));

    const settle = async (until: (status: NonNullable<Awaited<ReturnType<typeof projectExecutionStatus>>>) => boolean) => {
      const started = Date.now();
      let latest: Awaited<ReturnType<typeof projectExecutionStatus>> = null;
      while (Date.now() - started < 60_000) {
        latest = await projectExecutionStatus(project.projectId).catch(() => null);
        if (latest && until(latest)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return latest;
    };

    // A native drafting round: a `stage.draft` command, delivered as the
    // round signal, drafted by the run's own agent step (the Brainstormer),
    // then evaluated by its own agent step (the brief evaluator) — nothing
    // in-process, and the thread and the evaluation are both projected back
    // from the run's events afterwards.
    /** The stage 1 brief the draft produced, or null when it did not. */
    let brief: { nodeId: string; artifactId: string; contentHash: string } | null = null;
    {
      const { requestDraft } = await import("../apps/hub/src/stage-runs.js");
      const { evaluationIn, threadTurns } = await import("../apps/hub/src/stage-thread.js");
      const { expectLiveDraft, subscribeLiveDraft } = await import("../apps/hub/src/live-drafts.js");

      const liveEvents: { type: string; text?: string }[] = [];
      expectLiveDraft(project.projectId, 1);
      const unsubscribeLive = subscribeLiveDraft(project.projectId, 1, (event) => {
        liveEvents.push(event.type === "text" ? { type: event.type, text: event.text } : { type: event.type });
      });

      const { stageIterations } = await import("../apps/hub/src/lifecycle-run.js");
      const beforeRound = await stageIterations(project.projectId, 1, { currentOnly: true });

      let drafted: Awaited<ReturnType<typeof requestDraft>> | { error: string };
      try {
        drafted = await requestDraft({
          projectId: project.projectId,
          stage: 1,
          runId: project.runId,
          actor: localActor(),
          message: "Cold outbound is rebuilt by hand every Monday.",
          mode: "final",
          projectTitle,
        });
      } catch (cause) {
        drafted = { error: cause instanceof Error ? cause.message : String(cause) };
      }
      unsubscribeLive();
      if ("draft" in drafted) brief = drafted.draft;

      check(
        "a stage.draft round produces a problem_brief version through the run's own agent step",
        "draft" in drafted && drafted.draft.content.includes("In short"),
        "error" in drafted ? drafted.error : drafted.draft.content.slice(0, 200),
      );

      // The round carried the call's output cap, and the specialist step read
      // it off the round and sent it to the provider: a written document runs
      // under the host's document cap, not the runtime's 4096 default.
      const brainstormerCall = completions.find((call) => JSON.stringify(call.messages).includes("You are the Brainstormer at stage 1."));
      check(
        "the draft step's provider call carried the round's output cap",
        brainstormerCall?.maxTokens === 16_000,
        `max_tokens ${String(brainstormerCall?.maxTokens)}`,
      );

      // By now the loop has spawned the next iteration, parked on its own
      // round signal. A wait that starts this late — a poll that missed the
      // window between this round's last step and that spawn — must still
      // find this round's iteration, not sit on the parked one until it
      // times out.
      {
        const { awaitIterationOutputs } = await import("../apps/hub/src/stage-runs.js");
        const { DRAFT_STEP_ID, EVALUATE_STEP_ID } = await import("@solutions-builder/app/workflows/stage-loop");
        let after = await stageIterations(project.projectId, 1, { currentOnly: true });
        const spawnWaitStarted = Date.now();
        while (after.length <= beforeRound.length && Date.now() - spawnWaitStarted < 30_000) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          after = await stageIterations(project.projectId, 1, { currentOnly: true });
        }
        const late = await awaitIterationOutputs({
          projectId: project.projectId,
          stage: 1,
          before: beforeRound,
          stepIds: [DRAFT_STEP_ID, EVALUATE_STEP_ID],
          timeoutMs: 5_000,
        }).catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
        check(
          "a wait that starts after the next iteration is parked still finds the round's own outputs",
          after.length > beforeRound.length && "outputs" in late && late.runId === beforeRound.at(-1)?.runId && late.outputs.has(DRAFT_STEP_ID),
          "error" in late ? late.error : `${late.runId} with ${[...late.outputs.keys()].join(",")}; ${beforeRound.length} iterations before, ${after.length} after`,
        );
      }

      const thread = "draft" in drafted ? await threadTurns(project.projectId, 1) : [];
      const opener = thread.find((entry) => entry.role === "specialist" && entry.questions !== null);
      check(
        "the projected thread carries a specialist turn with two questions",
        opener?.questions?.length === 2,
        JSON.stringify(opener),
      );
      check(
        "nextQuestion reads the first of them off the projected thread",
        (await (await import("../apps/hub/src/questions.js")).nextQuestion(project.projectId, 1))?.ordinal === 0,
      );

      const iterationsAfterDraft = await (await import("../apps/hub/src/lifecycle-run.js")).stageIterations(
        project.projectId,
        1,
      );
      const evaluation = await evaluationIn(iterationsAfterDraft);
      check(
        "the brief evaluator's verdict projects from its own agent step",
        evaluation?.ready === false && evaluation.notes.length > 0,
        JSON.stringify(evaluation),
      );

      check(
        "the live-draft pane streamed the round from the run's own inference events",
        liveEvents.some((event) => event.type === "begin") && liveEvents.some((event) => event.type === "done"),
        JSON.stringify(liveEvents).slice(0, 400),
      );
    }

    // From here the ledger is walked with its own commands, the way the app
    // does it: the engine commits each transition and delivers the signal
    // the run waits on. The run and the ledger then agree at every stage,
    // which stage 5's draft below depends on.
    const { writeArtifact, projectDetail } = await import("../apps/hub/src/projects.js");
    const { produceStageArtifact, advanceStage } = await import("./lib/stage-walk.js");
    const ACTOR = { ...localActor(), displayName: "Smoke" };
    const walkCtx = { projectId: project.projectId, runId: project.runId, actor: ACTOR };
    const currentRunId = async () => (await projectDetail(project.projectId, ACTOR.principalId)).current!.id;
    const versionOf = (node: { nodeId: string; artifactId: string; contentHash: string }) => [
      { artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash },
    ];

    // A round whose call the provider refuses does not draft. The person who
    // waited on it learns so from the thread: a turn that says the round did
    // not complete and what the platform reported.
    if (brief) {
      const { requestDraft } = await import("../apps/hub/src/stage-runs.js");
      const { threadTurns } = await import("../apps/hub/src/stage-thread.js");
      refuseRounds = true;
      let refusedError = "";
      try {
        await requestDraft({
          projectId: project.projectId,
          stage: 1,
          runId: project.runId,
          actor: localActor(),
          message: "Also, the handoff to sales is by spreadsheet.",
          mode: "final",
          projectTitle,
        });
      } catch (cause) {
        refusedError = cause instanceof Error ? cause.message : String(cause);
      } finally {
        refuseRounds = false;
      }
      const failedTurn = (await threadTurns(project.projectId, 1)).find((turn) => turn.failed === true);
      check(
        "a round the provider refuses is a turn in the thread that says so, with what the platform reported",
        failedTurn?.role === "specialist" && failedTurn.body.includes("did not complete") && failedTurn.body.includes("stub: this package is refused"),
        failedTurn ? failedTurn.body.slice(0, 300) : `no failed turn; request said ${JSON.stringify(refusedError).slice(0, 300)}`,
      );
      if (!failedTurn) {
        const { debugRuns } = await import("../apps/hub/src/lifecycle-run.js");
        console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 6000));
        console.log("THREAD", JSON.stringify(await threadTurns(project.projectId, 1)).slice(0, 3000));
      }
      await settle((s) => s.parked && s.stage === 1);
    }

    const briefVersion = brief ? versionOf(brief) : await produceStageArtifact(walkCtx, 1);
    const stage1 = await advanceStage(walkCtx, 1, briefVersion);
    check("stage.submit lands on the parked loop as its round signal", stage1.submitDelivery === "delivered", stage1.submitDelivery);
    if (!stage1.gate) {
      const { debugRuns } = await import("../apps/hub/src/lifecycle-run.js");
      console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 6000));
    }
    check(
      "the submit ends the round and the run parks at the stage 1 gate",
      stage1.gate?.parked === true && stage1.gate.stepId === gateStepId(1) && stage1.gate.signalName === approveSignal(1),
      stage1.gate ? `${stage1.gate.stepId} ${stage1.gate.signalName ?? ""}` : "no status",
    );

    check("stage.approve lands on the gate", stage1.approveDelivery === "delivered", stage1.approveDelivery);
    const atStage2 = stage1.next;
    check(
      "the approval opens stage 2, parked on its first round",
      atStage2?.parked === true && atStage2.stepId.startsWith(reviseStepId(2)) && atStage2.signalName === roundSignal(2),
      atStage2 ? `${atStage2.stepId} ${atStage2.signalName ?? ""}` : "no status",
    );

    // The run is a shadow of the ledger and sees only signals, so the walk to
    // the build stage is the ledger's own commands: submit ends each round,
    // approve (cost.approve at stage 7) opens the next stage.
    let walked = atStage2?.parked === true && atStage2.stage === 2;
    for (const stage of [2, 3, 4, 5, 6, 7] as const) {
      if (!walked) break;
      // Stages 2 to 4 through the engine, with a version to submit and
      // approve; stage 5 and beyond by raw signal, since the ledger's own
      // stage 5 approval needs stakeholder decisions this smoke does not
      // record, and the run alone is what the build stage below needs.
      if (stage <= 4) {
        const version = await produceStageArtifact(walkCtx, stage as 1 | 2 | 3 | 4);
        const { gate, next } = await advanceStage(walkCtx, stage, version);
        walked = gate?.stepId === gateStepId(stage) && next?.stage === stage + 1;
        continue;
      }
      // Stage 5 writes one package per stakeholder, each behind its own
      // gate. A package that fails is that package's failure: the others
      // are recorded and it is reported, and a later round writes it alone,
      // skipping the packages that already exist.
      if (stage === 5) {
        const { requestDraft } = await import("../apps/hub/src/stage-runs.js");
        const packagerCalls = () =>
          completions.filter((call) => JSON.stringify(call.messages).includes("You are the Presentation creator at stage 5.")).length;
        const draftPackages = async (audiences?: string[]) => {
          try {
            return await requestDraft({
              projectId: project.projectId,
              stage: 5,
              // Each approval opens a new run at the next stage; the one
              // the project was created with ended at stage 1.
              runId: await currentRunId(),
              actor: localActor(),
              message: "",
              mode: "final",
              projectTitle,
              ...(audiences ? { audiences } : {}),
            });
          } catch (cause) {
            return { error: cause instanceof Error ? cause.message : String(cause) };
          }
        };

        packageToFail = "Finance lead";
        const first = await draftPackages();
        check(
          "a stakeholder's package that fails is reported, and the others are recorded",
          "packages" in first &&
            first.packages?.length === 1 &&
            first.packages[0]?.content.includes("Audience: Project owner") === true &&
            first.failed?.length === 1 &&
            first.failed[0]?.audience === "Finance lead",
          "error" in first ? first.error : JSON.stringify({ packages: first.packages?.length, failed: first.failed }),
        );

        check(
          "the failure names the provider and model that were asked",
          "failed" in first && first.failed?.[0]?.message.includes("Stub provider · stub-large") === true,
          "failed" in first ? String(first.failed?.[0]?.message).slice(0, 160) : "",
        );
        check(
          "a recorded package names the model that wrote it",
          "packages" in first && first.packages?.[0]?.model === "stub-large" && first.packages[0].providerId === "compatible",
          "packages" in first ? `${first.packages?.[0]?.providerId}/${first.packages?.[0]?.model}` : "",
        );

        packageToFail = null;
        const before = packagerCalls();
        const again = await draftPackages(["Finance lead"]);
        check(
          "the failed package is written again on its own",
          "packages" in again &&
            again.packages?.length === 1 &&
            again.packages[0]?.content.includes("Audience: Finance lead") === true &&
            again.failed === undefined,
          "error" in again ? again.error : JSON.stringify({ packages: again.packages?.length, failed: again.failed }),
        );
        check("the round that writes one package again runs no other package step", packagerCalls() - before === 1, `${packagerCalls() - before} calls`);

        const { projectDetail } = await import("../apps/hub/src/projects.js");
        const current = (await projectDetail(project.projectId, localActor().principalId)).nodes.filter(
          (node) => node.kind === "audience_package" && node.supersededByNodeId === null,
        );
        check(
          "both stakeholders now hold a current package",
          current.length === 2 && ["Project owner", "Finance lead"].every((name) => current.some((node) => node.variant === name)),
          current.map((node) => `${node.variant}:v${node.version}`).join(","),
        );
        // Each package's deck outline becomes a PowerPoint beside it: a file
        // artifact the person saves, never an input the model is handed.
        const { readArtifactNode } = await import("../apps/hub/src/projects.js");
        const decks = (await projectDetail(project.projectId, localActor().principalId)).nodes.filter(
          (node) => node.kind === "audience_deck" && node.supersededByNodeId === null,
        );
        const deckBytes = await Promise.all(
          decks.map(async (node) => {
            const { content } = await readArtifactNode(node.id);
            const match = /^data:([^;]+);base64,(.*)$/s.exec(content);
            return { variant: node.variant, mime: match?.[1] ?? "", head: match ? Buffer.from(match[2]!, "base64").subarray(0, 2).toString() : "" };
          }),
        );
        check(
          "each stakeholder's package has a PowerPoint built beside it",
          deckBytes.length === 2 &&
            deckBytes.every((deck) => deck.mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" && deck.head === "PK"),
          JSON.stringify(deckBytes),
        );
        const { stageInputsForSmoke } = await import("../apps/hub/src/stage-runs.js");
        check("the slides are never handed to a later stage as an input", !(await stageInputsForSmoke(project.projectId, 6 as never)).includes("base64"));
        // A package written before decks existed has none; asking for its
        // slides builds them from the package as it is, once.
        const { ensureDeckFor } = await import("../apps/hub/src/deck.js");
        const older = await writeArtifact(
          {
            projectId: project.projectId,
            kind: "audience_package" as never,
            variant: "Project owner",
            title: "Audience package — Project owner",
            content: "## Audience: Project owner\n\n### Deck outline\n\n1. **Only slide**  \n   One line of body.\n\n### Decision request\n- Decide.",
            mediaType: "text/markdown",
            sourceVersionIds: [],
            provenance: { producer: "human", runId: await currentRunId() },
          },
          ACTOR,
        );
        const deckOnce = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        const deckAgain = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        check(
          "slides asked for from a package without any are built from it, once",
          deckOnce.built && !deckAgain.built && deckAgain.nodeId === deckOnce.nodeId,
          `${deckOnce.built}/${deckAgain.built}`,
        );
        // A role's design changed in Settings: the next save builds a new
        // version with the new look; the package is untouched.
        const { saveDeckDesign } = await import("../apps/hub/src/deck-settings.js");
        await saveDeckDesign("project_owner", { theme: "forest", typeface: "Georgia" });
        const redesigned = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        const redesignedAgain = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        check(
          "a changed deck design for the role builds the slides again, once",
          redesigned.built && redesigned.nodeId !== deckOnce.nodeId && !redesignedAgain.built,
          `${redesigned.built}/${redesignedAgain.built}`,
        );
        // Images: drawn by the connected provider's image model when the
        // slides are asked for, one per slide plus the cover, and kept so a
        // second build asks for nothing.
        await saveDeckDesign("project_owner", { images: "some" });
        const drawn = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        const asked = imagePrompts.length;
        const drawnAgain = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        const { content: drawnContent } = await readArtifactNode(drawn.nodeId);
        const drawnBytes = Buffer.from(/base64,(.*)$/s.exec(drawnContent)![1]!, "base64");
        const { mkdtemp, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const dir = await mkdtemp(join(tmpdir(), "sb-deck-"));
        await Bun.write(join(dir, "deck.pptx"), drawnBytes);
        const mediaParts = Bun.spawnSync(["unzip", "-Z1", join(dir, "deck.pptx")]).stdout.toString().split("\n").filter((name) => /^ppt\/media\/image[\w-]*\.png$/.test(name));
        await rm(dir, { recursive: true, force: true });
        check(
          "a model reads the deck and chooses the slides to illustrate; the image model draws those, and only those",
          drawn.built && asked === 2 && mediaParts.length === 2 && imagePrompts.every((prompt) => /No text, no words/.test(prompt)),
          `built=${drawn.built} asked=${asked} media=${mediaParts.length}`,
        );
        check(
          "each picture is asked for as the art director's subject, drawn from the deck's content",
          imagePrompts.some((prompt) => prompt.startsWith("A maintainer at a desk")) && imagePrompts.some((prompt) => prompt.startsWith("A Monday calendar page")),
          imagePrompts.map((prompt) => prompt.slice(0, 40)).join(" | "),
        );
        check("and a second build draws nothing again", !drawnAgain.built && imagePrompts.length === asked, `${imagePrompts.length} prompts`);
        await saveDeckDesign("project_owner", { images: "none", theme: "ember", typeface: "Calibri" });
        // A style guide kept for the role: the next build is on that
        // PowerPoint — its master survives, our slides sit on its layouts.
        const { storeTemplate, removeTemplate } = await import("../apps/hub/src/deck-template.js");
        const { default: PptxGenJS } = await import("pptxgenjs");
        const fixture = new PptxGenJS();
        fixture.defineSlideMaster({
          title: "HOUSE",
          background: { color: "0B3D91" },
          objects: [
            { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.4, w: 9, h: 1 } } },
            { placeholder: { options: { name: "body", type: "body", x: 0.5, y: 1.6, w: 9, h: 3.4 } } },
          ],
        });
        fixture.addSlide({ masterName: "HOUSE" }).addText("Old", { placeholder: "title" });
        const fixtureBytes = new Uint8Array((await fixture.write({ outputType: "nodebuffer" })) as Buffer);
        await storeTemplate("project_owner", { name: "house.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: fixtureBytes });
        const onTemplate = await ensureDeckFor({ packageNodeId: older.nodeId, actor: ACTOR });
        const { content: templatedContent } = await readArtifactNode(onTemplate.nodeId);
        const templatedBytes = Buffer.from(/base64,(.*)$/s.exec(templatedContent)![1]!, "base64");
        const dir2 = await mkdtemp(join(tmpdir(), "sb-deck-"));
        await Bun.write(join(dir2, "deck.pptx"), templatedBytes);
        const templatedParts = Bun.spawnSync(["unzip", "-Z1", join(dir2, "deck.pptx")]).stdout.toString().split("\n");
        // The library keeps a master's background on its layout; either way it is still there.
        const master = templatedParts
          .filter((name) => /^ppt\/(slideMasters|slideLayouts)\/[^/]+\.xml$/.test(name))
          .map((name) => Bun.spawnSync(["unzip", "-p", join(dir2, "deck.pptx"), name]).stdout.toString())
          .join("");
        const slideCount = templatedParts.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
        await rm(dir2, { recursive: true, force: true });
        check(
          "a style guide kept for the role makes the next build a deck on that PowerPoint",
          onTemplate.built && master.includes("0B3D91") && slideCount === 3,
          `built=${onTemplate.built} master=${master.includes("0B3D91")} slides=${slideCount}`,
        );
        await removeTemplate("project_owner");
        await saveDeckDesign("project_owner", { template: null });
      }
      const { gate, next } = await advanceStage(walkCtx, stage);
      walked = gate?.stepId === gateStepId(stage) && next?.stage === stage + 1;
    }
    const atStage8 = await settle((s) => s.parked && s.stage === 8);
    check(
      "submit and approve at every stage walk the run to the build stage",
      walked && atStage8?.parked === true && atStage8.signalName === roundSignal(8),
      atStage8 ? `${atStage8.stepId} ${atStage8.signalName ?? ""}` : "no status",
    );

    if (atStage8?.parked && atStage8.stage === 8) {
      const beforeBuild = completions.length;

      // The stub streams "## In short\n- Build attempt acknowledged." as two
      // chunks; the live-draft pane should show the round taking shape from
      // the run's own inference events, not just the finished reply.
      const { expectLiveDraft, subscribeLiveDraft } = await import("../apps/hub/src/live-drafts.js");
      const liveEvents: { type: string; text?: string }[] = [];
      const rawAgentEvents: unknown[] = [];
      const unsubscribeRaw = hub().events.on("agent.event", (frame) => rawAgentEvents.push(frame));
      expectLiveDraft(project.projectId, 8);
      const unsubscribeLive = subscribeLiveDraft(project.projectId, 8, (event) => {
        liveEvents.push(event.type === "text" ? { type: event.type, text: event.text } : { type: event.type });
      });

      const attempt = await deliverStageSignal(project.projectId, "build.start_attempt", { runId: project.runId }, `smoke-attempt-${project.projectId}`);
      check("build.start_attempt lands on the stage 8 round", attempt === "delivered", attempt);
      const buildStarted = Date.now();
      const beforeRequests = requests.length;
      let seen = false;
      const authorizedCompletion = () =>
        requests
          .slice(beforeRequests)
          .find((line) => line.includes("POST") && line.includes("/chat/completions") && line.endsWith(" authorized"));
      while (Date.now() - buildStarted < 120_000) {
        if (authorizedCompletion() !== undefined && completions.length > beforeBuild) {
          seen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // The agent step ran under the sidecar, presented the sealed key as the
      // bearer, and the stub answered. A 401 here means the credential row
      // still holds a keychain reference instead of the key.
      check(
        "the build agent runs under the sidecar and calls the tenant's offering",
        seen,
        seen
          ? `${authorizedCompletion()} after ${((Date.now() - buildStarted) / 1000).toFixed(1)}s, answered (${completions.at(-1)?.messages.length} messages)`
          : `no authorised completion reached the stub (${requests.slice(beforeRequests).join("; ") || "no requests"})`,
      );
      if (!seen) {
        const { debugRuns } = await import("../apps/hub/src/lifecycle-run.js");
        console.log("STUB REQUESTS", JSON.stringify(requests.slice(-10)));
        console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 12000));
      }

      // The sidecar relays the step's inference cycle asynchronously over its
      // own websocket; give it room to arrive after the stub has answered.
      const liveWaitStarted = Date.now();
      while (Date.now() - liveWaitStarted < 30_000) {
        if (liveEvents.some((event) => event.type === "done")) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      unsubscribeRaw();
      unsubscribeLive();

      const begun = liveEvents.some((event) => event.type === "begin");
      const texted = liveEvents.some(
        (event) => event.type === "text" && (event.text ?? "").includes("Build attempt acknowledged"),
      );
      const done = liveEvents.some((event) => event.type === "done");
      check(
        "the live draft streams a begin, the acknowledged text and a done from the run's own inference events",
        begun && texted && done,
        begun && texted && done
          ? "begin/text/done all seen"
          : `begin=${begun} text=${texted} done=${done}; live=${JSON.stringify(liveEvents).slice(0, 500)}; agent.event frames=${JSON.stringify(rawAgentEvents).slice(0, 1500)}`,
      );

      // Each round call the stub answered is the project's spend, from the
      // same events: one record per inference.done, in the stub's own name.
      const { usageRecords } = await import("../apps/hub/src/engine-ledger.js");
      const { projectSpend } = await import("../apps/hub/src/spend.js");
      const rounds = (await usageRecords(project.projectId)).filter((record) => record.source === "round");
      const spend = await projectSpend(project.projectId);
      const stubRow = spend.rows.find((row) => row.provider === "compatible" && row.model === "stub-large");
      check(
        "every round's call is recorded as the project's spend, under the connected provider that answered",
        rounds.length >= 1 &&
          rounds.every((record) => record.provider === "compatible" && record.model === "stub-large" && record.calls === 1 && record.runId?.startsWith("run_") === true) &&
          stubRow !== undefined &&
          stubRow.calls >= rounds.length,
        `${rounds.length} round records ${JSON.stringify(rounds.slice(0, 2))}; rows=${JSON.stringify(spend.rows)}`,
      );

      const afterBuild = await settle((s) => s.parked && s.stage === 8 && s.signalName === roundSignal(8));
      check(
        "the attempt's round ends and the build stage waits for the next command",
        afterBuild?.parked === true && afterBuild.stage === 8,
        afterBuild ? `${afterBuild.stepId} ${afterBuild.signalName ?? ""}` : "no status",
      );
      if (!afterBuild?.parked) {
        const { debugRuns } = await import("../apps/hub/src/lifecycle-run.js");
        console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 8000));
      }

    }
  }
} finally {
  stub.close();
  hub().stopReconcile();
  const { stopSpawnedSidecars } = await import("../apps/hub/src/sidecar-processes.js");
  await stopSpawnedSidecars(join(dataDir, "hub"));
  await server.stop(true);
  await host.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`Sidecar smoke: ${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
