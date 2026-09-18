/**
 * The design revision prompt — BUILD_PLAN_V3 section 10.
 *
 * Pure prompt construction: anchoring comments to elements of an exact
 * design version, choosing an overall direction, and turning both into a
 * revision prompt. The revision prompt is deterministic — the same feedback
 * produces byte-identical bytes, so a regenerated design is attributable.
 * Nothing here touches the database or the artifact store — the caller
 * (`apps/web`'s design page) builds the pieces and delivers the result as a
 * `stage.draft` run signal; this module only renders the prompt.
 *
 * Anchors degrade rather than break: a stable test id where one exists, a DOM
 * path plus a role and text fingerprint where one does not. A stale anchor is
 * reported as stale, never silently dropped.
 */
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

export function anchorLabel(anchor: Anchor): string {
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
