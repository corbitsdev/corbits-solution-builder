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

const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const SECRET = "sk-stub-do-not-store-me-anywhere";
/** Every chat completion the stub answered: the agent step ran under the sidecar. */
const completions: { model: string; messages: unknown[] }[] = [];
/** Every request the stub saw, for diagnosis when the agent never arrives. */
const requests: string[] = [];
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
      const parsed = JSON.parse(body) as { model: string; messages: unknown[] };
      completions.push({ model: parsed.model, messages: parsed.messages });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: "## In short\n- Build attempt acknowledged." }, null));
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
  const { localActor } = await import("../apps/hub/src/hub-client.js");
  const { projectExecutionStatus, deliverStageSignal, parkedSignalNames } = await import("../apps/hub/src/hub-executor.js");
  const project = await createProject({
    title: "Smoke: runs on the hub",
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
      const attempt = await deliverStageSignal(project.projectId, "build.start_attempt", { runId: project.runId }, `smoke-attempt-${project.projectId}`);
      check("build.start_attempt lands on the stage 8 round", attempt === "delivered", attempt);
      const buildStarted = Date.now();
      const beforeRequests = requests.length;
      let seen = false;
      const completionRequest = () => requests.slice(beforeRequests).find((line) => line.includes("POST") && line.includes("/chat/completions"));
      while (Date.now() - buildStarted < 120_000) {
        if (completionRequest() !== undefined) {
          seen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // The agent step ran under the sidecar and asked the tenant's offering
      // for a completion. Whether the request was authorised is reported, not
      // asserted: the hub's credential row carries the keychain reference, not
      // the key (catalog.ts), so the sidecar presents that reference as the
      // bearer token. Closing that gap is a product decision, tracked on the
      // ticket, not something this smoke can paper over.
      check(
        "the build agent runs under the sidecar and calls the tenant's offering",
        seen,
        seen
          ? `${completionRequest()} after ${((Date.now() - buildStarted) / 1000).toFixed(1)}s${completions.length > beforeBuild ? `, answered (${completions.at(-1)?.messages.length} messages)` : ""}`
          : "no completion request reached the stub",
      );
      if (!seen) {
        const { debugRuns } = await import("../apps/hub/src/hub-executor.js");
        console.log("STUB REQUESTS", JSON.stringify(requests.slice(-10)));
        console.log("DIAG", JSON.stringify(await debugRuns(project.projectId), null, 1).slice(0, 12000));
      }
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
