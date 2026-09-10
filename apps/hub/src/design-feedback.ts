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

export const DIRECTIONS = ["choose", "combine", "revise", "reject"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DISPOSITIONS = ["open", "addressed", "declined", "superseded"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type Anchor = {
  /** Preferred: a stable semantic or test id captured from the element. */
  readonly testId?: string;
  /** Fallback: the DOM path, kept with enough context to survive small edits. */
  readonly domPath?: string;
  readonly role?: string;
  readonly textFingerprint?: string;
  readonly viewport?: { width: number; height: number };
};

export type Comment = {
  readonly id: string;
  readonly anchor: Anchor;
  readonly body: string;
  readonly author: string;
  readonly disposition: Disposition;
};

export type Feedback = {
  readonly id: string;
  readonly designNodeId: string;
  readonly direction: Direction;
  readonly comments: readonly Comment[];
  readonly overallNote: string;
  readonly submittedAt: string;
  readonly promptHash: string;
};

function anchorLabel(anchor: Anchor): string {
  if (anchor.testId) return `#${anchor.testId}`;
  if (anchor.domPath) {
    const role = anchor.role ? ` role=${anchor.role}` : "";
    const text = anchor.textFingerprint ? ` text="${anchor.textFingerprint}"` : "";
    return `${anchor.domPath}${role}${text}`;
  }
  return "(whole design)";
}

/**
 * Builds the revision prompt. Deterministic by construction: comments are
 * ordered by their anchor label and then by id, and nothing time-varying is
 * interpolated. Two runs over the same feedback produce the same bytes.
 */
export function revisionPrompt(args: {
  designTitle: string;
  designVersion: number;
  designContentHash: string;
  direction: Direction;
  overallNote: string;
  comments: readonly Comment[];
  acceptanceCriteria: readonly string[];
}): string {
  const ordered = [...args.comments].sort((left, right) => {
    const byAnchor = anchorLabel(left.anchor).localeCompare(anchorLabel(right.anchor));
    return byAnchor !== 0 ? byAnchor : left.id.localeCompare(right.id);
  });

  const conflicts = detectConflicts(ordered);

  return [
    `# Design revision request`,
    ``,
    `## Source design`,
    `${args.designTitle}, version ${args.designVersion}.`,
    `sha256 ${args.designContentHash}`,
    ``,
    `## Overall direction`,
    `${args.direction}${args.overallNote ? `: ${args.overallNote}` : ""}`,
    ``,
    `## Anchored comments`,
    ...(ordered.length === 0
      ? ["(none)"]
      : ordered.map((comment, index) => `${index + 1}. ${anchorLabel(comment.anchor)} — ${comment.body}`)),
    ``,
    `## Unresolved conflicts`,
    ...(conflicts.length === 0
      ? ["(none)"]
      : conflicts.map((conflict) => `- ${conflict}`)),
    ``,
    `## Acceptance criteria this revision must still satisfy`,
    ...(args.acceptanceCriteria.length === 0
      ? ["(none recorded)"]
      : args.acceptanceCriteria.map((criterion) => `- ${criterion}`)),
    ``,
    `Produce the next design version. Address every comment above, or say`,
    `explicitly which you are declining and why. Do not silently drop one.`,
  ].join("\n");
}

/**
 * Two comments on the same anchor are flagged rather than merged. A designer
 * resolving them by guesswork is how contradictory feedback becomes an
 * unexplained design change.
 */
function detectConflicts(comments: readonly Comment[]): string[] {
  const byAnchor = new Map<string, Comment[]>();
  for (const comment of comments) {
    const label = anchorLabel(comment.anchor);
    byAnchor.set(label, [...(byAnchor.get(label) ?? []), comment]);
  }
  return Array.from(byAnchor.entries())
    .filter(([, entries]) => entries.length > 1)
    .map(
      ([label, entries]) =>
        `${label} has ${entries.length} comments; they may conflict and a human must reconcile them.`,
    );
}

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

