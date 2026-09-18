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
const { connectProvider } = await import("./lib/dev-provider.js");
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

/** Every illustration the stub was asked to draw. */
const imagePrompts: string[] = [];
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Which canned reply a completion gets, told apart by a phrase distinctive to each role's own system prompt; null refuses the call. */
function replyFor(messages: unknown[]): string | null {
  const text = JSON.stringify(messages);
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
  const { projectExecutionStatus, parkedSignalNames } = await import("../apps/hub/src/lifecycle-run.js");
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
    // round signal the run's own agent steps consume. The prompt the steps
    // run and the versions they write are the workflow's from here (the
    // CL-8279 follow-up owns them); the smoke asserts the signal lands on
    // the parked run and the loop wakes for it, not what the round writes.
    {
      const { signalDraft } = await import("./lib/stage-walk.js");
      const { stageIterations } = await import("../apps/hub/src/lifecycle-run.js");
      const beforeRound = await stageIterations(project.projectId, 1, { currentOnly: true });

      let delivery = "none";
      let signalError = "";
      try {
        delivery = await signalDraft(
          { projectId: project.projectId, runId: project.runId, actor: localActor() },
          1,
          { message: "Cold outbound is rebuilt by hand every Monday." },
        );
      } catch (cause) {
        signalError = cause instanceof Error ? cause.message : String(cause);
      }
      check(
        "a stage.draft round is delivered as the round signal to the parked run",
        delivery === "delivered",
        signalError || delivery,
      );

      // The loop wakes for the round: a new iteration appears past the
      // snapshot's parked one, whatever the round's own steps go on to do.
      let after = await stageIterations(project.projectId, 1, { currentOnly: true });
      const spawnWaitStarted = Date.now();
      while (after.length <= beforeRound.length && Date.now() - spawnWaitStarted < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        after = await stageIterations(project.projectId, 1, { currentOnly: true });
      }
      check(
        "the delivered round wakes the loop past the parked iteration",
        after.length > beforeRound.length,
        `${beforeRound.length} iterations before, ${after.length} after`,
      );
      await settle((s) => s.parked && s.stage === 1);
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
    // The stage 1 brief is produced through the ledger walk below, so the
    // run and the ledger agree before the walk starts.
    const briefVersion = await produceStageArtifact(walkCtx, 1);
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
      // Stage 5 writes one package per stakeholder through its own round
      // signal; the prompt the steps run and the versions they write are
      // the workflow's from here (the CL-8279 follow-up owns them, and
      // restores the package and deck checks below). The smoke asserts the
      // signal lands on the parked run and the run re-parks for the submit.
      if (stage === 5) {
        const { signalDraft } = await import("./lib/stage-walk.js");
        let delivery = "none";
        let signalError = "";
        try {
          delivery = await signalDraft(walkCtx, 5, { message: "" });
        } catch (cause) {
          signalError = cause instanceof Error ? cause.message : String(cause);
        }
        check(
          "a stage.draft round is delivered as the round signal to the parked stage 5 run",
          delivery === "delivered",
          signalError || delivery,
        );
        await settle((s) => s.parked && s.stage === 5);
        // Each package's deck outline becomes a PowerPoint beside it: a file
        // artifact the person saves, never an input the model is handed. The
        // round's own packages cover this once the workflow owns the prompt
        // again (the CL-8279 follow-up); here the hand-written package below
        // carries the deck checks.
        const { stageInputsForSmoke } = await import("../apps/hub/src/stage-runs.js");
        check("the slides are never handed to a later stage as an input", !(await stageInputsForSmoke(project.projectId, 6 as never)).inputs.includes("base64"));
        // A package written before decks existed has none; asking for its
        // slides builds them from the package as it is, once.
        const { deckForPackage } = await import("../apps/hub/src/deck.js");
        const { HostError } = await import("../apps/hub/src/errors.js");
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
        let missingMessage = "";
        try {
          await deckForPackage(older.nodeId);
        } catch (cause) {
          missingMessage = cause instanceof HostError ? cause.message : String(cause);
        }
        check(
          "a package with no recorded slides is not built by the host",
          /no slides for this package/.test(missingMessage),
          missingMessage.slice(0, 120),
        );
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
