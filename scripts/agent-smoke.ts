/**
 * Agent-path smoke.
 *
 * The loop smoke proves the gates without a provider. This proves the other
 * half: that a stage specialist actually drafts through the inference port,
 * that the draft passes boundary validation, and that it lands as an approvable
 * version with a content hash.
 *
 * It needs a reachable local endpoint. With none, it says so and exits 0 —
 * an absent provider is not a failing test.
 *
 * Usage: bun scripts/agent-smoke.ts [--base-url http://127.0.0.1:11434]
 */
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { createProject, projectDetail } from "../apps/hub/src/projects.js";
import { connectProvider } from "../apps/hub/src/providers.js";
import { draftStageArtifact } from "../apps/hub/src/agent-run.js";
import { execute } from "../apps/hub/src/engine.js";
import { newId } from "../apps/hub/src/ids.js";

const index = process.argv.indexOf("--base-url");
const baseUrl = index >= 0 ? process.argv[index + 1]! : "http://127.0.0.1:11434";
const ACTOR = { principalId: "p_owner", displayName: "Agent smoke" };

const reachable = await fetch(new URL("/v1/models", baseUrl), {
  signal: AbortSignal.timeout(3_000),
})
  .then((response) => response.ok)
  .catch(() => false);

if (!reachable) {
  console.log(`No local endpoint at ${baseUrl}. Skipping the agent path.`);
  process.exit(0);
}

const host = await openDatabase(
  process.env.SOLUTIONS_BUILDER_DATA_DIR
    ? `${process.env.SOLUTIONS_BUILDER_DATA_DIR}/pglite-agent`
    : undefined,
);
await prepareDatabase(host);

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
const { selectModel } = await import("../apps/hub/src/providers.js");
await selectModel("local", preferred);
console.log(`PASS  model selected explicitly - ${preferred}`);

const detail = await projectDetail(created.projectId, ACTOR.principalId);
const draft = await draftStageArtifact({
  projectId: created.projectId,
  branchId: created.branchId,
  stage: 1,
  runId: detail.current!.id,
  actor: ACTOR,
  projectTitle: "A chess game I can actually play",
  userInput:
    "I want to play chess against something that is actually fun to play against, " +
    "not a stockfish that crushes me instantly. I have no idea what is involved.",
});

console.log(`PASS  the Brainstormer drafted through ${draft.model}`);
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
  const afterApproval = await projectDetail(created.projectId, ACTOR.principalId);
  // Fast-forward to stage 4 by approving stages 2 and 3 with placeholder
  // artifacts; the point of this section is the designer's output shape.
  const { writeArtifact } = await import("../apps/hub/src/projects.js");
  for (const [stage, kind] of [
    [2, "solution_constraints"],
    [3, "chosen_approach"],
  ] as const) {
    const detailNow = await projectDetail(created.projectId, ACTOR.principalId);
    const node = await writeArtifact(
      {
        projectId: created.projectId,
        branchId: created.branchId,
        kind,
        title: `Stage ${stage}`,
        content: `# Stage ${stage}\n\nA desktop app, local only, macOS.`,
        mediaType: "text/markdown",
        sourceVersionIds: [],
        provenance: { producer: "human" },
      },
      ACTOR,
    );
    const version = {
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
        payload: { runId: detailNow.current!.id, versions: [version] },
      });
    }
  }
  void afterApproval;

  const atFour = await projectDetail(created.projectId, ACTOR.principalId);
  const design = await draftStageArtifact({
    projectId: created.projectId,
    branchId: created.branchId,
    stage: 4,
    runId: atFour.current!.id,
    actor: ACTOR,
    projectTitle: "A chess game I can actually play",
    userInput: "Keep it to one board screen and a new-game screen.",
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

await host.close();
