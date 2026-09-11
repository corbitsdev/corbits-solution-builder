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
const { install } = await import("../apps/hub/src/install.js");
const { connectProvider } = await import("../apps/hub/src/providers.js");
const { ensureLifecycleDeployment, LIFECYCLE_ASSET_NAME } = await import(
  "../apps/hub/src/workflow-deploy.js"
);
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

/** Which canned reply a completion gets, told apart by a phrase distinctive to each role's own system prompt. */
function replyFor(messages: unknown[]): string {
  const text = JSON.stringify(messages);
  if (text.includes("You are the Brainstormer at stage 1.")) return BRAINSTORMER_REPLY;
  if (text.includes("You are the Brief evaluator inside Solutions Builder")) return EVALUATOR_REPLY;
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
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: replyFor(parsed.messages) }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "stub-large" }] }));
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
  const { projectExecutionStatus, deliverStageSignal, parkedSignalNames } = await import("../apps/hub/src/hub-executor.js");
  const projectTitle = "Smoke: runs on the hub";
  const project = await createProject({
    title: projectTitle,
    owner: { ...localActor(), displayName: "Smoke" },
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 500,
      audiences: [{ name: "Project owner", role: "project_owner" }],
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
    {
      const { requestDraft } = await import("../apps/hub/src/stage-runs.js");
      const { evaluationIn, threadTurns } = await import("../apps/hub/src/stage-thread.js");
      const { expectLiveDraft, subscribeLiveDraft } = await import("../apps/hub/src/live-drafts.js");

      const liveEvents: { type: string; text?: string }[] = [];
      expectLiveDraft(project.projectId, 1);
      const unsubscribeLive = subscribeLiveDraft(project.projectId, 1, (event) => {
        liveEvents.push(event.type === "text" ? { type: event.type, text: event.text } : { type: event.type });
      });

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

      const iterationsAfterDraft = await (await import("../apps/hub/src/hub-executor.js")).stageIterations(
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

    const submitted = await deliverStageSignal(project.projectId, "stage.submit", { runId: project.runId }, `smoke-submit-${project.projectId}`);
    check("stage.submit lands on the parked loop as its round signal", submitted === "delivered", submitted);
    const atGate = await settle((s) => s.parked && s.stepId === gateStepId(1));
    if (!atGate) {
      const { debugRuns } = await import("../apps/hub/src/hub-executor.js");
      console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 6000));
    }
    check(
      "the submit ends the round and the run parks at the stage 1 gate",
      atGate?.parked === true && atGate.stepId === gateStepId(1) && atGate.signalName === approveSignal(1),
      atGate ? `${atGate.stepId} ${atGate.signalName ?? ""}` : "no status",
    );

    const approved = await deliverStageSignal(project.projectId, "stage.approve", { runId: project.runId }, `smoke-approve-${project.projectId}`);
    check("stage.approve lands on the gate", approved === "delivered", approved);
    const atStage2 = await settle((s) => s.parked && s.stage === 2);
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
      await deliverStageSignal(project.projectId, "stage.submit", { runId: project.runId }, `smoke-submit-${stage}-${project.projectId}`);
      const gate = await settle((s) => s.parked && s.stepId === gateStepId(stage));
      const advance = stage === 7 ? "cost.approve" : "stage.approve";
      await deliverStageSignal(project.projectId, advance, { runId: project.runId }, `smoke-approve-${stage}-${project.projectId}`);
      const next = await settle((s) => s.parked && s.stage === stage + 1);
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
        const { debugRuns } = await import("../apps/hub/src/hub-executor.js");
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

      const afterBuild = await settle((s) => s.parked && s.stage === 8 && s.signalName === roundSignal(8));
      check(
        "the attempt's round ends and the build stage waits for the next command",
        afterBuild?.parked === true && afterBuild.stage === 8,
        afterBuild ? `${afterBuild.stepId} ${afterBuild.signalName ?? ""}` : "no status",
      );
      if (!afterBuild?.parked) {
        const { debugRuns } = await import("../apps/hub/src/hub-executor.js");
        console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 8000));
      }
    }
  }
} finally {
  stub.close();
  const { stopSpawnedSidecars } = await import("../apps/hub/src/sidecar-processes.js");
  await stopSpawnedSidecars(join(dataDir, "hub"));
  await server.stop(true);
  await host.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`Sidecar smoke: ${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
