/**
 * The canonical design-feedback flow — BUILD_PLAN_V3 section 10.
 *
 * Stage 4 iterates on a design by anchoring comments to elements of an exact
 * design version, choosing an overall direction, and turning both into a
 * revision prompt. Three properties make it a record rather than a chat:
 *
 *   - feedback is immutable once submitted;
 *   - the revision prompt is deterministic — the same feedback produces
 *     byte-identical bytes, so a regenerated design is attributable;
 *   - every comment's disposition is carried forward to the next version, so
 *     "what happened to my note" is answerable without reading a diff.
 *
 * Anchors degrade rather than break: a stable test id where one exists, a DOM
 * path plus a role and text fingerprint where one does not. A stale anchor is
 * reported as stale, never silently dropped.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { database } from "./db.js";
import * as table from "./schema.js";
import { newId, sha256 } from "./ids.js";
import { HostError, notFound } from "./errors.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import {
  revisionPrompt,
  type Anchor,
  type Comment,
  type Direction,
  type Disposition,
  type Feedback,
} from "@solutions-builder/app/design-prompt";

export {
  DIRECTIONS,
  DISPOSITIONS,
  revisionPrompt,
  type Anchor,
  type Comment,
  type Direction,
  type Disposition,
  type Feedback,
} from "@solutions-builder/app/design-prompt";

/**
 * Whether a stable id still names an element in the design, matched as a whole
 * attribute value across the attribute spellings a generated mockup may use.
 */
function resolvesTestId(content: string, testId: string): boolean {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attributes = ["data-testid", "data-test-id", "id"];
  return attributes.some((attribute) =>
    new RegExp(`${attribute}\\s*=\\s*["']${escaped}["']`).test(content),
  );
}

// Guards a design node's feedback thread against a concurrent second
// submission within this process. The desktop host is single-process, so
// this is sufficient without a database-level claim.
const submissionsInFlight = new Set<string>();

/** The latest `design_feedback` artifact node for a design node, if any. */
async function feedbackNodeRow(designNodeId: string) {
  const { db } = database();
  const [row] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.kind, "design_feedback"),
        eq(table.artifactNode.variant, designNodeId),
      ),
    )
    .orderBy(desc(table.artifactNode.version))
    .limit(1);
  return row;
}

/**
 * Submits immutable feedback against an exact design version, and records the
 * deterministic revision prompt beside it.
 */
export async function submitFeedback(args: {
  projectId: string;
  designNodeId: string;
  direction: Direction;
  overallNote: string;
  comments: { anchor: Anchor; body: string }[];
  author: string;
  acceptanceCriteria?: string[];
}): Promise<{ feedback: Feedback; prompt: string; feedbackNodeId: string }> {
  const { db } = database();

  const [design] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.id, args.designNodeId),
        eq(table.artifactNode.projectId, args.projectId),
      ),
    );
  if (!design) throw notFound("That design version");
  if (design.kind !== "design_artifact") {
    throw new HostError("validation_failed", "Feedback attaches to a design artifact.");
  }

  // Submitted feedback is immutable. A second round attaches to the version
  // the designer produced, not to the one already reviewed, so a design node
  // that already has a feedback thread refuses another submission. The
  // in-flight set closes the check-then-act window within this process.
  if (submissionsInFlight.has(args.designNodeId)) {
    throw new HostError(
      "conflict",
      "Feedback was already submitted against this design version. " +
        "Comment on the revision it produced instead.",
    );
  }
  submissionsInFlight.add(args.designNodeId);
  try {
    if (await feedbackNodeRow(args.designNodeId)) {
      throw new HostError(
        "conflict",
        "Feedback was already submitted against this design version. " +
          "Comment on the revision it produced instead.",
      );
    }

    const comments: Comment[] = args.comments.map((comment) => ({
      id: newId.flag(),
      anchor: comment.anchor,
      body: comment.body,
      author: args.author,
      disposition: "open",
    }));

    const prompt = revisionPrompt({
      designTitle: design.title,
      designVersion: design.version,
      designContentHash: design.contentHash,
      direction: args.direction,
      overallNote: args.overallNote,
      comments,
      acceptanceCriteria: args.acceptanceCriteria ?? [],
    });

    const feedback: Feedback = {
      id: newId.flag(),
      designNodeId: args.designNodeId,
      direction: args.direction,
      comments,
      overallNote: args.overallNote,
      submittedAt: new Date().toISOString(),
      promptHash: await sha256(prompt),
    };

    // The feedback is itself a versioned artifact, so it carries the same
    // lineage, hash and provenance guarantees as anything else at this stage.
    // `variant` scopes it to this exact design node, so later dispositions
    // append versions to the same thread instead of colliding with another
    // design node's feedback.
    const node = await writeArtifact(
      {
        projectId: args.projectId,
        kind: "design_feedback",
        variant: args.designNodeId,
        title: `Design feedback on ${design.title} v${design.version}`,
        content: JSON.stringify({ feedback, prompt }, null, 2),
        mediaType: "application/json",
        sourceVersionIds: [args.designNodeId],
        provenance: { producer: "human" },
      },
      { principalId: args.author },
    );

    return { feedback, prompt, feedbackNodeId: node.nodeId };
  } finally {
    submissionsInFlight.delete(args.designNodeId);
  }
}

export async function feedbackFor(designNodeId: string): Promise<{ feedback: Feedback; prompt: string } | null> {
  const row = await feedbackNodeRow(designNodeId);
  if (!row) return null;
  const { content } = await readArtifactNode(row.id);
  const value = JSON.parse(content) as { feedback?: Feedback; prompt?: string };
  return value.feedback && value.prompt
    ? { feedback: value.feedback, prompt: value.prompt }
    : null;
}

/**
 * Records how the designer disposed of each comment on the version it produced,
 * and reports anchors that no longer resolve in the new design as stale rather
 * than dropping them.
 */
export async function recordDisposition(args: {
  designNodeId: string;
  newDesignNodeId: string;
  dispositions: { commentId: string; disposition: Disposition; note?: string }[];
  actor: { principalId: string };
}): Promise<{ carried: Comment[]; stale: string[] }> {
  const node = await feedbackNodeRow(args.designNodeId);
  if (!node) throw notFound("Feedback for that design version");
  const stored = await feedbackFor(args.designNodeId);
  if (!stored) throw notFound("Feedback for that design version");

  const byId = new Map(args.dispositions.map((entry) => [entry.commentId, entry]));
  const carried = stored.feedback.comments.map((comment) => ({
    ...comment,
    disposition: byId.get(comment.id)?.disposition ?? ("open" as Disposition),
  }));

  const { content } = await readArtifactNode(args.newDesignNodeId);
  // An anchor is stale when its test id no longer appears in the new design.
  // The id must match a whole attribute value, not a substring: `resign` and
  // `resign-confirm` are different elements, and a substring match would report
  // a renamed element as still present.
  const stale = carried
    .filter(
      (comment) =>
        comment.anchor.testId !== undefined &&
        !resolvesTestId(content, comment.anchor.testId),
    )
    .map((comment) => `${comment.id} (${comment.anchor.testId})`);

  // Dispositioning writes a new version onto the same feedback thread —
  // `variant` keeps it scoped to this design node so it revises rather than
  // starting a sibling artifact.
  await writeArtifact(
    {
      projectId: node.projectId,
      kind: "design_feedback",
      variant: args.designNodeId,
      title: node.title,
      content: JSON.stringify(
        { feedback: { ...stored.feedback, comments: carried }, prompt: stored.prompt, supersededBy: args.newDesignNodeId, stale },
        null,
        2,
      ),
      mediaType: "application/json",
      sourceVersionIds: [args.designNodeId],
      provenance: { producer: "agent" },
    },
    { principalId: args.actor.principalId },
  );

  return { carried, stale };
}

/** Design versions on a branch, oldest first, for the before/after lineage view. */
export async function designHistory(projectId: string) {
  const { db } = database();
  return db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, projectId),
        eq(table.artifactNode.kind, "design_artifact"),
      ),
    )
    .orderBy(asc(table.artifactNode.version));
}
