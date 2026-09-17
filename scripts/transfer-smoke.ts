/**
 * A project carried out of one instance and into another.
 *
 * Everything the product records about a project is a ledger turn or an
 * artifact version, so a project travels as exactly those, and an import
 * replays them rather than re-deciding anything. This drives a project two
 * stages in, exports it, imports the bundle into the same workspace as a new
 * project, and checks that what folds out of the copy is what folded out of
 * the original: stage and state, every version's hash, every approval, every
 * command — with new project and artifact ids and nothing else changed.
 *
 * Usage: bun --conditions intx-src scripts/transfer-smoke.ts
 */
import { givenDataDir } from "./smoke-env.js";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub, localActor } from "../apps/hub/src/hub-client.js";
import { install } from "./host-install.js";
import { createProject, projectDetail, writeArtifact } from "../apps/hub/src/projects.js";
import { execute } from "../apps/hub/src/engine.js";
import { newId } from "../apps/hub/src/ids.js";
import { ledgerCommands, recordCarriedTurns } from "../apps/hub/src/engine-ledger.js";
import { threadTurns } from "../apps/hub/src/stage-thread.js";
import { nextQuestion } from "../apps/hub/src/questions.js";
import { submitFeedback, feedbackFor } from "../apps/hub/src/design-feedback.js";
import { exportProject, importProject, parseBundle, bundleFileName } from "../apps/hub/src/project-transfer.js";
import { HostError } from "../apps/hub/src/errors.js";
import type { Command, Stage } from "@solutions-builder/app/ledger";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const host = await openDatabase(
  givenDataDir ? `${givenDataDir}/pglite-transfer` : undefined,
);
await prepareDatabase(host);
await ensureHub();
await install();
const ACTOR = { ...localActor(), displayName: "Transfer smoke" };

async function command(type: Command, projectId: string, payload: Record<string, unknown>) {
  return execute({ type, actor: ACTOR, projectId, idempotencyKey: newId.command(), correlationId: newId.correlation(), payload });
}

// --- A project two stages in, with a revised brief and a design under review.
const created = await createProject({
  title: "Transfer smoke",
  owner: ACTOR,
  policy: {
    costTolerancePercent: 10,
    costToleranceAbsolute: 500,
    audiences: [{ name: "Project owner", role: "project_owner" }],
    audienceQuorum: 1,
    allowExternalProviders: true,
  },
  problemStatement: "Carrying a project between two copies of the app loses everything.",
});
const source = created.projectId;

async function stageDocument(projectId: string, stage: Stage, kind: "problem_brief" | "solution_constraints" | "chosen_approach" | "design_artifact", body: string, mediaType: "text/markdown" | "text/html" = "text/markdown") {
  const detail = await projectDetail(projectId, ACTOR.principalId);
  return writeArtifact(
    {
      projectId,
      kind,
      title: kind.replace(/_/g, " "),
      content: body,
      mediaType,
      sourceVersionIds: detail.nodes.filter((node) => node.supersededByNodeId === null && node.stage < stage).map((node) => node.id),
      provenance: { producer: "human", runId: detail.current!.id },
    },
    ACTOR,
  );
}
async function submitAndApprove(projectId: string, node: { artifactId: string; nodeId: string; contentHash: string }, approve: boolean) {
  const detail = await projectDetail(projectId, ACTOR.principalId);
  const version = { artifactId: node.artifactId, versionId: node.nodeId, contentHash: node.contentHash };
  await command("stage.submit", projectId, { runId: detail.current!.id, versions: [version] });
  if (approve) await command("stage.approve", projectId, { runId: detail.current!.id, versions: [version] });
}

await stageDocument(source, 1, "problem_brief", "# Problem brief\n\nFirst draft.");
const brief = await stageDocument(source, 1, "problem_brief", "# Problem brief\n\nRevised: the real pain is named.");
await submitAndApprove(source, brief, true);
const constraints = await stageDocument(source, 2, "solution_constraints", "# Solution constraints\n\nDesktop only.");
await submitAndApprove(source, constraints, true);
const approach = await stageDocument(source, 3, "chosen_approach", "# Solution proposal\n\n## Approach A\n\nThe one.");
await submitAndApprove(source, approach, true);
const design = await stageDocument(source, 4, "design_artifact", "<!doctype html><html><body><h1 data-testid=\"title\">Mock</h1></body></html>", "text/html");
await submitFeedback({
  projectId: source,
  designNodeId: design.nodeId,
  direction: "revise",
  overallNote: "Bigger title.",
  comments: [{ anchor: { testId: "title" }, body: "Too small." }],
  author: ACTOR.principalId,
});
await submitAndApprove(source, design, false);

// --- Out, and back in.
// The conversation with the stage's specialist does not live on the ledger
// at home; carried in, it is kept there. Two questions asked, one answered:
// the second must still be open once the project has travelled.
await recordCarriedTurns(source, 3, [
  { id: "turn-q", role: "specialist", body: "Two things before I choose.", quotes: [], resultNodeId: null, questions: ["Which platform first?", "Who signs off?"], createdAt: "2026-09-14T10:00:00.000Z" },
  { id: "turn-a", role: "human", body: "Desktop first.", quotes: [], resultNodeId: null, questions: null, createdAt: "2026-09-14T10:01:00.000Z" },
]);
check("at home, the second question is the open one", (await nextQuestion(source, 3))?.body === "Who signs off?", JSON.stringify(await nextQuestion(source, 3)));

const bundle = await exportProject(source);
check("the bundle names its format and version", bundle.format === "solutions-builder.project" && bundle.version === 1);
check("the bundle carries every version with its bytes", bundle.artifacts.nodes.length === 6 && bundle.artifacts.nodes.every((node) => node.content.length > 0), `${bundle.artifacts.nodes.length} nodes`);
check("the bundle carries the whole ledger", bundle.ledger.length === (await ledgerCommands(source)).length, `${bundle.ledger.length} entries`);
check(
  "the bundle carries the conversation, questions included",
  bundle.conversations?.some((entry) => entry.stage === 3 && entry.turns.length === 2 && entry.turns[0]?.questions?.length === 2) === true,
  JSON.stringify(bundle.conversations?.map((entry) => [entry.stage, entry.turns.length])),
);
check("the bundle carries no provider or credential", !JSON.stringify(bundle).includes("credential") && !/sk-|enc:aead/.test(JSON.stringify(bundle)));
check("the file name is the title made safe", bundleFileName(bundle.project.title) === "transfer-smoke.solutions-builder.json", bundleFileName(bundle.project.title));

// The bundle survives a round trip through text, as a file would.
const carried = parseBundle(JSON.parse(JSON.stringify(bundle)));
const imported = await importProject(carried, ACTOR);
check("import opens a new project here", imported.projectId !== source && imported.projectId.startsWith("tnt_"), imported.projectId);

const before = await projectDetail(source, ACTOR.principalId);
const after = await projectDetail(imported.projectId, ACTOR.principalId);
check("the copy stands where the original stands", after.current?.stage === before.current?.stage && after.current?.state === before.current?.state, `${after.current?.stage} ${after.current?.state}`);
check("the copy's run ids are the original's", after.current?.id === before.current?.id && after.runs.length === before.runs.length);
// Documents travel byte for byte. A JSON record that names a node — the
// design's feedback — is rewritten to the new names, so its hash is new too;
// it is compared by what it says, below, not by its bytes.
const documents = (detail: typeof before) =>
  detail.nodes.filter((node) => node.mediaType !== "application/json").map((node) => `${node.kind}:${node.version}:${node.contentHash}`).sort();
check("every document version is there with the same hash and number", JSON.stringify(documents(after)) === JSON.stringify(documents(before)) && after.nodes.length === before.nodes.length, `${after.nodes.length} nodes`);
const superseded = (detail: typeof before) =>
  detail.nodes
    .filter((node) => node.supersededByNodeId !== null)
    .map((node) => `${node.kind} v${node.version} -> v${detail.nodes.find((next) => next.id === node.supersededByNodeId)?.version ?? "?"}`)
    .sort();
check("supersession is carried and points at nodes that exist here", JSON.stringify(superseded(after)) === JSON.stringify(superseded(before)) && superseded(after).every((link) => !link.endsWith("?")), superseded(after).join(", "));
check("the node ids are this workspace's own, so a bundle can come back where it left", after.nodes.every((node) => !before.nodes.some((original) => original.id === node.id)));
check("the artifact ids are the store's own here", after.nodes.every((node) => !before.nodes.some((original) => original.artifactId === node.artifactId)));
check("every approval is there and names a version that exists here", after.approvals.length === before.approvals.length && after.approvals.every((approval) => approval.versions.every((version) => after.nodes.some((node) => node.id === version.versionId && node.contentHash === version.contentHash))), `${after.approvals.length} approvals`);
const carriedThread = await threadTurns(imported.projectId, 3);
check(
  "the copy's conversation reads as it did at home, and the same question is still open",
  carriedThread.some((turn) => turn.id === "turn-q" && turn.questions?.length === 2) &&
    carriedThread.some((turn) => turn.id === "turn-a") &&
    (await nextQuestion(imported.projectId, 3))?.body === "Who signs off?",
  JSON.stringify(await nextQuestion(imported.projectId, 3)),
);
check("the copy is waiting on the same decision", after.waits.length === before.waits.length && after.waits[0]?.title === before.waits[0]?.title, after.waits[0]?.title ?? "none");
const designHere = after.nodes.find((node) => node.kind === "design_artifact" && node.contentHash === design.contentHash);
const carriedFeedback = designHere ? await feedbackFor(designHere.id) : null;
check("the design's feedback names the design by its new id, inside and out", carriedFeedback !== null && carriedFeedback.feedback.comments.length === 1 && carriedFeedback.feedback.designNodeId === designHere?.id, designHere?.id ?? "no design");
check("the copy's ledger is as long as the original's", (await ledgerCommands(imported.projectId)).length === (await ledgerCommands(source)).length);
check("the copy's opening problem statement is the original's", (await ledgerCommands(imported.projectId)).find((entry) => entry.command === "project.create")?.message === "Carrying a project between two copies of the app loses everything.");

// A second export, of the copy, equals the first except for the minted ids.
const again = await exportProject(imported.projectId);
const normalize = (b: typeof bundle) => {
  // Ids are the receiving instance's own; a JSON record's bytes name them,
  // so its hash and size follow. Everything else must come out the same.
  const nodes = b.artifacts.nodes.map(({ artifactId: _a, contentHash, sizeBytes, ...rest }) =>
    rest.mediaType === "application/json" ? rest : { ...rest, contentHash, sizeBytes },
  );
  let text = JSON.stringify({ ledger: b.ledger.map((e) => e.metadata), nodes, edges: b.artifacts.edges });
  text = text.replaceAll(b.project.id, "PROJECT");
  b.artifacts.nodes.forEach((node, index) => {
    text = text.replaceAll(node.id, `NODE${index}`);
  });
  // The store's artifact ids are named by approvals; they are minted here
  // too, so each is read by the order its first version appears in.
  [...new Set(b.artifacts.nodes.map((node) => node.artifactId))].forEach((artifactId, index) => {
    text = text.replaceAll(artifactId, `ARTIFACT${index}`);
  });
  return text;
};
check("exporting the copy gives the same bundle, ids and what names them aside", normalize(again) === normalize(bundle));

// What is refused.
for (const [name, raw] of [
  ["not an export at all", { hello: "world" }],
  ["a later format version", { ...bundle, version: 99 }],
  ["a bundle with no opening command", { ...bundle, ledger: bundle.ledger.filter((e) => e.metadata.command !== "project.create") }],
] as const) {
  let refused: string | null = null;
  try {
    parseBundle(raw);
  } catch (cause) {
    refused = cause instanceof HostError ? cause.code : String(cause);
  }
  check(`${name} is refused before anything is written`, refused === "validation_failed", refused ?? "accepted");
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nTransfer smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
await host.close();
process.exit(failed.length === 0 ? 0 : 1);
