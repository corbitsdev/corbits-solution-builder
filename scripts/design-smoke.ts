/**
 * Design-feedback smoke — BUILD_PLAN_V3 section 10's canonical flow.
 *
 * Proves the properties that make the flow a record rather than a conversation:
 * anchoring, immutability, prompt determinism, conflict detection, disposition
 * carry-forward and stale-anchor reporting. No provider is needed — the design
 * versions are written directly, so the flow is testable on its own.
 */
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub, localActor } from "../apps/hub/src/hub-client.js";
import { install } from "../apps/hub/src/install.js";
import { createProject, writeArtifact } from "../apps/hub/src/projects.js";
import {
  feedbackFor,
  recordDisposition,
  revisionPrompt,
  submitFeedback,
} from "../apps/hub/src/design-feedback.js";
import { HostError } from "../apps/hub/src/errors.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const host = await openDatabase(
  process.env.SOLUTIONS_BUILDER_DATA_DIR
    ? `${process.env.SOLUTIONS_BUILDER_DATA_DIR}/pglite-design`
    : undefined,
);
await prepareDatabase(host);
await ensureHub();
await install();
const ACTOR = { ...localActor(), displayName: "Design smoke" };

const project = await createProject({
  title: "Design smoke",
  owner: ACTOR,
  policy: {
    costTolerancePercent: 10,
    costToleranceAbsolute: 100,
    audiences: [],
    audienceQuorum: 0,
    allowExternalProviders: false,
  },
});

const design = await writeArtifact(
  {
    projectId: project.projectId,
    branchId: project.branchId,
    kind: "design_artifact",
    title: "Board screen",
    content: `<main data-testid="board"><h1>Chess</h1><button data-testid="resign">Resign</button></main>`,
    mediaType: "text/html",
    sourceVersionIds: [],
    provenance: { producer: "agent", agentRole: "experience-designer" },
  },
  ACTOR,
);
check("a design version exists to anchor against", Boolean(design.nodeId));

const comments = [
  { anchor: { testId: "resign" }, body: "Resign needs a confirmation step." },
  {
    anchor: { domPath: "main > h1", role: "heading", textFingerprint: "Chess" },
    body: "The heading should name the opponent.",
  },
  { anchor: { testId: "resign" }, body: "Actually, move Resign out of the primary row." },
];

const submitted = await submitFeedback({
  projectId: project.projectId,
  branchId: project.branchId,
  designNodeId: design.nodeId,
  direction: "revise",
  overallNote: "Close, but the destructive action is too easy to hit.",
  comments,
  author: ACTOR.principalId,
  acceptanceCriteria: ["Every destructive action is confirmable."],
});
check("feedback submits against an exact design version", submitted.feedback.comments.length === 3);

check(
  "two comments on one anchor are reported as a conflict rather than merged",
  submitted.prompt.includes("may conflict and a human must reconcile"),
);

check(
  "the prompt carries the source version's content hash",
  submitted.prompt.includes(design.contentHash),
);

// Determinism: rebuilding the prompt from the same feedback must be identical.
const rebuilt = revisionPrompt({
  designTitle: "Board screen",
  designVersion: 1,
  designContentHash: design.contentHash,
  direction: "revise",
  overallNote: "Close, but the destructive action is too easy to hit.",
  comments: submitted.feedback.comments,
  acceptanceCriteria: ["Every destructive action is confirmable."],
});
check("the revision prompt is deterministic", rebuilt === submitted.prompt);

// And order-independent: shuffled comments produce the same bytes.
const shuffled = revisionPrompt({
  designTitle: "Board screen",
  designVersion: 1,
  designContentHash: design.contentHash,
  direction: "revise",
  overallNote: "Close, but the destructive action is too easy to hit.",
  comments: [...submitted.feedback.comments].reverse(),
  acceptanceCriteria: ["Every destructive action is confirmable."],
});
check("the prompt does not depend on the order comments arrived in", shuffled === submitted.prompt);

try {
  await submitFeedback({
    projectId: project.projectId,
    branchId: project.branchId,
    designNodeId: design.nodeId,
    direction: "reject",
    overallNote: "Changed my mind.",
    comments: [],
    author: ACTOR.principalId,
  });
  check("submitted feedback is immutable", false, "a second submission was accepted");
} catch (cause) {
  check(
    "submitted feedback is immutable",
    cause instanceof HostError && cause.code === "conflict",
    cause instanceof HostError ? cause.code : "unexpected error",
  );
}

// The designer produces a new version that addresses one anchor and drops another.
const revised = await writeArtifact(
  {
    projectId: project.projectId,
    branchId: project.branchId,
    kind: "design_artifact",
    title: "Board screen",
    content: `<main data-testid="board"><h1>Chess vs. Ada</h1><footer><button data-testid="resign-confirm">Resign…</button></footer></main>`,
    mediaType: "text/html",
    sourceVersionIds: [design.nodeId],
    provenance: { producer: "agent", agentRole: "experience-designer" },
  },
  ACTOR,
);

const disposed = await recordDisposition({
  designNodeId: design.nodeId,
  newDesignNodeId: revised.nodeId,
  dispositions: [
    { commentId: submitted.feedback.comments[0]!.id, disposition: "addressed" },
    { commentId: submitted.feedback.comments[1]!.id, disposition: "addressed" },
    { commentId: submitted.feedback.comments[2]!.id, disposition: "declined" },
  ],
});
check(
  "every comment carries a disposition into the next version",
  disposed.carried.every((comment) => comment.disposition !== "open"),
);
check(
  "a declined comment is recorded as declined rather than dropped",
  disposed.carried.filter((comment) => comment.disposition === "declined").length === 1,
);
check(
  "an anchor whose stable id no longer resolves is reported as stale",
  disposed.stale.length === 2,
  `${disposed.stale.length} stale anchor(s) — the two on data-testid="resign"`,
);

const stored = await feedbackFor(design.nodeId);
check("dispositions persist for the before/after view", stored !== null);

await host.close();
const failed = checks.filter((entry) => !entry.ok);
console.log(`\nDesign feedback smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
