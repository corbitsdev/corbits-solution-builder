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
const stub = createServer((request, response) => {
  if ((request.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
    response.writeHead(401).end("{}");
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
