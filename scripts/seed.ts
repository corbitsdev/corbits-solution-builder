/**
 * Drives a fresh workspace to a given lifecycle stage, then hands off to the
 * dev server on that same data directory.
 *
 *   bun run seed                          stage 3, the default
 *   bun run seed --stage 8
 *   bun run seed --stage 8 --problem problem.txt
 *
 * Reaching stage 8 parks the run at the build round, ready for a
 * `build.start_attempt` — this script never fires that itself.
 *
 * The data directory is retained, never deleted, and printed on exit as
 * `SOLUTIONS_BUILDER_DATA_DIR=<path>` so it can be reattached later:
 *   SOLUTIONS_BUILDER_DATA_DIR=<path> bun run dev
 *
 * Provider: `SOLUTIONS_BUILDER_SEED_BASE_URL`, when set, connects a
 * `local_endpoint` at that URL (the remote Ollama case). Otherwise this stands
 * up the same in-process stub `sidecar-smoke.ts` uses and connects it as
 * `api_key` — fully offline, and the default path.
 *
 * `--problem <path>` opens the project with that file's contents as the
 * problem statement, titled the same deterministic way the create-project
 * route titles one (`titleFromProblem`) — never the model-naming path, so
 * the title stays reproducible across runs. Without it the project is
 * titled `Seed: stage N`.
 *
 * The stage walk lives in `scripts/lib/stage-walk.ts`, shared with
 * `sidecar-smoke.ts` for stages 1-4 (produce the stage artifact, submit,
 * settle at the gate, approve, settle at the next stage) so the two cannot
 * drift there. Stages 5-7 go through the same engine for real too — the
 * smoke's own stages 5-7 only move its shadow workflow forward, which is
 * enough to test the sidecar's build-stage mechanics but never actually
 * moves the ledger, so it would leave the ledger parked at stage 5 forever
 * and `build.start_attempt` would find no real `build/queued` run to start.
 */
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const stage = Number(arg("stage") ?? "3");
if (!Number.isInteger(stage) || stage < 1 || stage > 8) {
  console.error(`Usage: bun run seed --stage <1-8> (default 3) [--problem <path>]\nGot: ${arg("stage") ?? "(none)"}`);
  process.exit(1);
}
const targetStage = stage as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const problemPath = arg("problem");
let problemStatement = "";
if (problemPath !== undefined) {
  if (!(await Bun.file(problemPath).exists())) {
    throw new Error(`--problem ${problemPath}: no such file`);
  }
  problemStatement = (await Bun.file(problemPath).text()).trim();
  if (problemStatement.length === 0) {
    throw new Error(`--problem ${problemPath}: the file is empty`);
  }
}

const dataDir = await mkdtemp(join(tmpdir(), "solutions-builder-seed-"));
process.env["SOLUTIONS_BUILDER_DATA_DIR"] = dataDir;

const { openDatabase } = await import("../apps/hub/src/db.js");
const { prepareDatabase } = await import("../apps/hub/src/migrate.js");
const { hub, hubWebSocket, mountHub, setHostPort } = await import("../apps/hub/src/hub-mount.js");
const { install } = await import("../apps/hub/src/install.js");
const { connectProvider } = await import("../apps/hub/src/providers.js");
const { ensureLifecycleDeployment } = await import("../apps/hub/src/workflow-deploy.js");
const { createProject } = await import("../apps/hub/src/projects.js");
const { localActor } = await import("../apps/hub/src/hub-client.js");
const { titleFromProblem } = await import("../apps/hub/src/title.js");
const { databaseDirectory } = await import("../apps/hub/src/paths.js");
const { attachLiveDrafts } = await import("../apps/hub/src/live-drafts.js");
const { stopSpawnedSidecars } = await import("../apps/hub/src/sidecar-processes.js");
const { walkToStage } = await import("./lib/stage-walk.js");

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!;
await probe.stop(true);
setHostPort(port);

const host = await openDatabase(databaseDirectory());
await prepareDatabase(host);
await mountHub();
attachLiveDrafts();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  websocket: hubWebSocket,
  fetch: (request, bun) => hub().app.fetch(request, bun),
});

/** Connects the requested provider and returns the offline stub's server, if it stood one up. */
async function connectSeedProvider(): Promise<ReturnType<typeof createServer> | null> {
  const remoteBaseUrl = process.env["SOLUTIONS_BUILDER_SEED_BASE_URL"];
  if (remoteBaseUrl) {
    console.log(`Connecting to ${remoteBaseUrl} as a local endpoint…`);
    await connectProvider({
      providerId: "local",
      label: "Seed endpoint",
      kind: "local_endpoint",
      baseUrl: remoteBaseUrl,
    });
    return null;
  }

  console.log("No SOLUTIONS_BUILDER_SEED_BASE_URL set; standing up the offline stub provider…");
  const SECRET = "sk-stub-do-not-store-me-anywhere";
  const stub = createServer((request, response) => {
    const authorized = (request.headers.authorization ?? "") === `Bearer ${SECRET}`;
    if (!authorized) {
      response.writeHead(401).end("{}");
      return;
    }
    // Nothing in the walk to stage 1-4 calls the model — every artifact is
    // written directly — so the stub only needs to answer the catalog probe
    // `connectProvider` makes while validating the key.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "stub-large" }, { id: "stub-image" }] }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as { port: number }).port;
  await connectProvider({
    providerId: "compatible",
    label: "Stub provider",
    kind: "api_key",
    secret: SECRET,
    baseUrl: `http://127.0.0.1:${stubPort}`,
  });
  return stub;
}

const rows = async (statement: ReturnType<typeof sql>) => {
  const out = (await host.db.execute(statement)) as { rows?: unknown[] } | unknown[];
  return (Array.isArray(out) ? out : out.rows ?? []) as Record<string, unknown>[];
};

let stub: ReturnType<typeof createServer> | null = null;
try {
  await install();
  stub = await connectSeedProvider();

  const deployed = await ensureLifecycleDeployment();
  if (deployed.status !== "deployed") {
    throw new Error(`the lifecycle did not deploy: ${deployed.status}`);
  }

  const waitStarted = Date.now();
  let allocations: Record<string, unknown>[] = [];
  let allocated = false;
  while (Date.now() - waitStarted < 90_000) {
    allocations = await rows(sql`SELECT "status", "failure_message", "sidecar_id" FROM "public"."sidecar_allocation"`);
    allocated = allocations.some((row) => row.status === "allocated" && hub().sidecars.connected().some((id) => id === row.sidecar_id));
    if (allocated) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!allocated) {
    throw new Error(
      `the deployment sidecar never allocated and connected: ${allocations.map((row) => `${row.status}${row.failure_message ? `: ${row.failure_message}` : ""}`).join(" | ")}`,
    );
  }

  const actor = { ...localActor(), displayName: "Seed" };
  const project = await createProject({
    title: problemStatement.length > 0 ? titleFromProblem(problemStatement) : `Seed: stage ${targetStage}`,
    owner: actor,
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
    ...(problemStatement.length > 0 ? { problemStatement } : {}),
  });

  const parked = await walkToStage({ projectId: project.projectId, runId: project.runId, actor }, targetStage, "Project owner");
  if (!parked?.parked || parked.stage !== targetStage) {
    throw new Error(`the run did not park at stage ${targetStage}: ${JSON.stringify(parked)}`);
  }
  console.log(`Project "${project.projectId}" parked at stage ${targetStage}.`);
} finally {
  stub?.close();
  hub().stopReconcile();
  await stopSpawnedSidecars(join(dataDir, "hub"));
  await server.stop(true);
  await host.close().catch(() => undefined);
}

console.log(`\nSOLUTIONS_BUILDER_DATA_DIR=${dataDir}\n`);
console.log("Starting the dev server on this workspace…\n");

const dev = Bun.spawn(["bun", join(import.meta.dir, "dev.ts")], {
  cwd: join(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir },
});
process.exit(await dev.exited);
