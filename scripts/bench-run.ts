/**
 * Drives a fresh workspace to a given lifecycle stage, then hands off to the
 * dev server on that same data directory.
 *
 *   bun run seed                          stage 3, the default
 *   bun run seed --stage 7
 *   bun run seed --stage 7 --problem problem.txt
 *
 * Reaching stage 7 parks the run at the build round; build itself now runs
 * as a sidecar tool, outside this host — this script has nothing left to
 * fire there.
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
 * drift there. Stages 5-7 go through the same engine for real too.
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
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const stage = Number(arg("stage") ?? "3");
if (!Number.isInteger(stage) || stage < 1 || stage > 7) {
  console.error(
    `Usage: bun run seed --stage <1-7> (default 3) [--problem <path>] [--seed-artifacts]\nGot: ${arg("stage") ?? "(none)"}`,
  );
  process.exit(1);
}
const targetStage = stage as 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Default: every stage 1-7 artifact is drafted by a real specialist round
// through a `stage.draft` round signal — this is what an end-to-end walk means. `--seed-artifacts`
// opts into the canned-text shortcut instead, for jumping straight to a stage
// to experiment there without sitting through every earlier stage's real
// round; its artifacts are legitimately `provenance.producer: "human"`.
const walkMode = flag("seed-artifacts") ? "seeded" : "real";
console.log(`Walk mode: ${walkMode}${walkMode === "seeded" ? " (canned artifacts, not drafted by a model)" : " (every stage drafted by its real specialist)"}`);

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
const { hub, hubWebSocket, mountHub, setHostPort } =
  await import("../apps/hub/src/hub-mount.js");
const { install, ensureLifecycleDeployment } = await import("./host-install.js");
const { connectProvider } = await import("./lib/dev-provider.js");
const { createProject } = await import("../apps/hub/src/projects.js");
const { localActor } = await import("../apps/hub/src/hub-client.js");
const { titleFromProblem } = await import("../apps/hub/src/title.js");
const { databaseDirectory } = await import("../apps/hub/src/paths.js");
const { stopSpawnedSidecars } =
  await import("../apps/hub/src/sidecar-processes.js");
const { walkToStage } = await import("./lib/stage-walk.js");

const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = probe.port!;
await probe.stop(true);
setHostPort(port);

const host = await openDatabase(databaseDirectory());
await prepareDatabase(host);
await mountHub();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  websocket: hubWebSocket,
  fetch: (request, bun) => hub().app.fetch(request, bun),
});

/** Connects the requested provider and returns the offline stub's server, if it stood one up. */
async function connectSeedProvider(): Promise<ReturnType<
  typeof createServer
> | null> {
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

  console.log(
    "No SOLUTIONS_BUILDER_SEED_BASE_URL set; standing up the offline stub provider…",
  );
  const SECRET = "sk-stub-do-not-store-me-anywhere";
  const stub = createServer((request, response) => {
    const authorized =
      (request.headers.authorization ?? "") === `Bearer ${SECRET}`;
    if (!authorized) {
      response.writeHead(401).end("{}");
      return;
    }
    // Nothing in the walk to stage 1-4 calls the model — every artifact is
    // written directly — so the stub only needs to answer the catalog probe
    // `connectProvider` makes while validating the key.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ id: "stub-large" }, { id: "stub-image" }] }),
    );
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
  const out = (await host.db.execute(statement)) as
    { rows?: unknown[] } | unknown[];
  return (Array.isArray(out) ? out : (out.rows ?? [])) as Record<
    string,
    unknown
  >[];
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
    allocations = await rows(
      sql`SELECT "status", "failure_message", "sidecar_id" FROM "public"."sidecar_allocation"`,
    );
    allocated = allocations.some(
      (row) =>
        row.status === "allocated" &&
        hub()
          .sidecars.connected()
          .some((id) => id === row.sidecar_id),
    );
    if (allocated) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!allocated) {
    throw new Error(
      `the deployment sidecar never allocated and connected: ${allocations.map((row) => `${row.status}${row.failure_message ? `: ${row.failure_message}` : ""}`).join(" | ")}`,
    );
  }

  const actor = { ...localActor(), displayName: "Seed" };
  const projectTitle =
    problemStatement.length > 0 ? titleFromProblem(problemStatement) : `Seed: stage ${targetStage}`;
  const project = await createProject({
    title: projectTitle,
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

  const parked = await walkToStage(
    { projectId: project.projectId, runId: project.runId, actor, projectTitle },
    targetStage,
    "Project owner",
    walkMode,
  );
  if (!parked?.parked || parked.stage !== targetStage) {
    throw new Error(
      `the run did not park at stage ${targetStage}: ${JSON.stringify(parked)}`,
    );
  }
  console.log(`Project "${project.projectId}" parked at stage ${targetStage}.`);
  console.log(`SOLUTIONS_BUILDER_DATA_DIR=${dataDir}`);
} finally {
  stub?.close();
  hub().stopReconcile();
  await stopSpawnedSidecars(join(dataDir, "hub"));
  await server.stop(true);
  // A cleanup failure is still worth seeing -- it means a host outlived the
  // run -- but it must not mask whatever sent us into `finally`.
  try {
    await host.close();
  } catch (cause) {
    console.error(
      `[bench] the host did not close cleanly: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
