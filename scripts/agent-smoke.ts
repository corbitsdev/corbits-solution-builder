/**
 * Agent-path smoke.
 *
 * The loop smoke proves the gates without a provider. This proves the other
 * half: that a stage specialist actually drafts through a real, reachable
 * model, riding the native run path — the lifecycle deploys, the round is a
 * `stage.draft` command, and the reply comes back through the run's own
 * agent step, not an in-process call. That means it needs the same serving
 * harness `sidecar-smoke.ts` uses: a real HTTP port a sidecar can dial back
 * into.
 *
 * It needs a reachable local endpoint. With none, it says so and exits 0 —
 * an absent provider is not a failing test.
 *
 * Usage: bun scripts/agent-smoke.ts [--base-url http://127.0.0.1:11434]
 */
import "./smoke-env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const index = process.argv.indexOf("--base-url");
const baseUrl = index >= 0 ? process.argv[index + 1]! : "http://127.0.0.1:11434";

const reachable = await fetch(new URL("/v1/models", baseUrl), {
  signal: AbortSignal.timeout(3_000),
})
  .then((response) => response.ok)
  .catch(() => false);

if (!reachable) {
  console.log(`No local endpoint at ${baseUrl}. Skipping the agent path.`);
  process.exit(0);
}

const dataDir = await mkdtemp(join(tmpdir(), "sb-agent-"));

const { openDatabase } = await import("../apps/hub/src/db.js");
const { prepareDatabase } = await import("../apps/hub/src/migrate.js");
const { hub, hubWebSocket, mountHub, setHostPort } = await import("../apps/hub/src/hub-mount.js");
const { install } = await import("../apps/hub/src/installer-bridge.js");
const { localActor } = await import("../apps/hub/src/hub-client.js");
const { connectProvider, selectModel } = await import("../apps/hub/src/providers.js");
const { createProject, projectDetail, writeArtifact } = await import("../apps/hub/src/projects.js");
const { requestDraft } = await import("../apps/hub/src/stage-runs.js");
const { projectExecutionStatus } = await import("../apps/hub/src/hub-executor.js");
const { execute } = await import("../apps/hub/src/engine.js");
const { newId } = await import("../apps/hub/src/ids.js");

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

try {
  await install();
  const ACTOR = { ...localActor(), displayName: "Agent smoke" };

  const provider = await connectProvider({
    kind: "local_endpoint",
    providerId: "local",
    label: "Local endpoint",
    baseUrl,
  });
  console.log(`PASS  local endpoint validated - ${provider.models.length} models`);

  // Model choice is explicit: an unnamed model on a local endpoint is the
  // difference between a stage that drafts in a minute and one that reads as hung.
  const preferred =
    process.env.AGENT_SMOKE_MODEL ??
    provider.models.find((model) => model.includes("llama3")) ??
    provider.models[0]!;
  await selectModel("local", preferred);
  console.log(`PASS  model selected explicitly - ${preferred}`);

  const created = await createProject({
    title: "Agent smoke: a chess game I can actually play",
    owner: ACTOR,
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 500,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
  });

  const parkedAt = Date.now();
  let status: Awaited<ReturnType<typeof projectExecutionStatus>> = null;
  while (Date.now() - parkedAt < 90_000) {
    status = await projectExecutionStatus(created.projectId).catch(() => null);
    if (status?.parked && status.stage === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!status?.parked) {
    console.log("FAIL  the project's run never parked at stage 1; the lifecycle did not deploy in time");
    process.exit(1);
  }
  console.log("PASS  the lifecycle deployed and stage 1 is parked, waiting on a person");

  const detail = await projectDetail(created.projectId, ACTOR.principalId);
  const { draft } = await requestDraft({
    projectId: created.projectId,
    stage: 1,
    runId: detail.current!.id,
    actor: ACTOR,
    message:
      "I want to play chess against something that is actually fun to play against, " +
      "not a stockfish that crushes me instantly. I have no idea what is involved.",
    mode: "final",
    projectTitle: "A chess game I can actually play",
  });

  console.log(`PASS  the Brainstormer drafted through the run's own agent step`);
  console.log(`      ${draft.content.length} characters, sha256 ${draft.contentHash.slice(0, 16)}...`);

  const headings = draft.content.match(/^##\s+.+$/gm) ?? [];
  console.log(`PASS  the draft carries ${headings.length} section headings`);

  // The draft is now an approvable version: submit and approve it for real.
  const version = {
    artifactId: draft.artifactId,
    versionId: draft.nodeId,
    contentHash: draft.contentHash,
  };
  await execute({
    type: "stage.submit",
    actor: ACTOR,
    projectId: created.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload: { runId: detail.current!.id, versions: [version] },
  });
  const approved = await execute({
    type: "stage.approve",
    actor: ACTOR,
    projectId: created.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload: { runId: detail.current!.id, versions: [version] },
  });
  console.log(
    `PASS  the model-produced artifact was approved and advanced to stage ${approved.stage}`,
  );

  console.log("\n--- first 900 characters of the drafted brief ---\n");
  console.log(draft.content.slice(0, 900));

  // --- Stage 4: the designer must produce an anchorable, self-contained mockup ---
  {
    // Fast-forward to stage 4 by approving stages 2 and 3 with placeholder
    // artifacts; the point of this section is the designer's output shape.
    for (const [stage, kind] of [
      [2, "solution_constraints"],
      [3, "chosen_approach"],
    ] as const) {
      const detailNow = await projectDetail(created.projectId, ACTOR.principalId);
      const node = await writeArtifact(
        {
          projectId: created.projectId,
          kind,
          title: `Stage ${stage}`,
          content: `# Stage ${stage}\n\nA desktop app, local only, macOS.`,
          mediaType: "text/markdown",
          sourceVersionIds: [],
          provenance: { producer: "human" },
        },
        ACTOR,
      );
      const stageVersion = {
        artifactId: node.artifactId,
        versionId: node.nodeId,
        contentHash: node.contentHash,
      };
      for (const type of ["stage.submit", "stage.approve"] as const) {
        await execute({
          type,
          actor: ACTOR,
          projectId: created.projectId,
          idempotencyKey: newId.command(),
          correlationId: newId.correlation(),
          payload: { runId: detailNow.current!.id, versions: [stageVersion] },
        });
      }
    }

    const atFour = await projectDetail(created.projectId, ACTOR.principalId);
    const { draft: design } = await requestDraft({
      projectId: created.projectId,
      stage: 4,
      runId: atFour.current!.id,
      actor: ACTOR,
      message: "Keep it to one board screen and a new-game screen.",
      mode: "final",
      projectTitle: "A chess game I can actually play",
    });

    const html = design.content;
    const testIds = Array.from(html.matchAll(/data-testid="([^"]+)"/g), (match) => match[1]!);
    const remote = /(src|href)\s*=\s*["']https?:/i.test(html);

    console.log(`\nPASS  the designer produced ${html.length} characters at stage 4`);
    console.log(
      `${html.trimStart().toLowerCase().startsWith("<!doctype") ? "PASS" : "FAIL"}  the design is a self-contained HTML document`,
    );
    console.log(
      `${testIds.length >= 3 ? "PASS" : "FAIL"}  the design carries anchorable ids - ${testIds.length}: ${testIds.slice(0, 8).join(", ")}`,
    );
    console.log(`${remote ? "FAIL" : "PASS"}  the design requests nothing over the network`);
    console.log(
      `${/<script/i.test(html) ? "FAIL" : "PASS"}  the design contains no scripts`,
    );
  }
} finally {
  const { stopSpawnedSidecars } = await import("../apps/hub/src/sidecar-processes.js");
  await stopSpawnedSidecars(join(dataDir, "hub"));
  await server.stop(true);
  await host.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}
