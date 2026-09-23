/**
 * CL-8687: the project workflow (`project-workflow.ts`'s
 * `ProjectWorkflowView`) is the process authority for stage approval and
 * send-back. This module is the pure planning (`reviewableArtifact`) plus
 * thin-IO (`approveStage`, `sendBack`) surface `pages/workspace/index.tsx`
 * calls into, so the page itself stays a thin caller.
 *
 * Decision ids are deterministic from `(projectId, stage, artifactId,
 * version, kind, epoch, attempt)`. `epoch` is `view.decisions.length` read
 * once at the start of the operation: a network-error retry re-reads the
 * same committed state and so re-derives the SAME ids (idempotent), but a
 * later round against the identical `(stage, artifactId, version)` --
 * re-approving after a send-back, most notably -- commits new decisions
 * first and so gets a fresh epoch and fresh ids, never colliding with the
 * earlier round's (which the hub would otherwise answer `signal_id_conflict`
 * on, since `at` differs but the id would not). `attempt` still separates a
 * REFUSED decision from its retry within the same epoch.
 */
import type { AudiencePolicy, DecisionRecord, ReviewState } from "@solutions-builder/app/project-workflow/contracts";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";

export type ArtifactRef = {
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
};

export type ReviewableArtifact = { readonly status: "found"; readonly node: ArtifactNode } | { readonly status: "persist_needed" } | { readonly status: "none" };

/**
 * A stage's reviewable artifact.
 *
 * Every stage but 8 has no artifact a specialist writes directly the browser
 * can trust as the reviewable version: the fallback path persists the
 * latest substantial chat draft as a new version
 * (`pages/workspace/index.tsx`'s `approve()`, via `persistStageDraft` --
 * CL-8687), and THAT reference is what goes into `open_review`.
 *
 * Stage 8 is different (CL-8723): `publish_workspace` uploads the build
 * archive itself through the run-scoped artifacts routes, stamping
 * `metadata.sb` the same way `persistStageDraft` does. `source.origin` is
 * NOT the signal this discriminates on -- the mounted module's own
 * `/artifacts/binary` route does not tag a run-scoped binary upload
 * `"workflow"` the way its text route does, so every binary upload reads
 * back `"imported"` regardless of who made it. `provenance.agentRole` is:
 * only `publish_workspace`'s own write sets it (`"build-engineer"`,
 * `specialist-source.ts`'s `agentFor(BUILD_STAGE).id`); the browser's own
 * `persistBuildEvidence` fallback write never does. The newest such node --
 * this project/stage/kind, not yet superseded -- IS the reviewable
 * artifact; approving it needs no browser write at all, and it is preferred
 * over `persist_needed` even when a chat draft (a status update, not the
 * archive) also exists.
 */
export function reviewableArtifact(input: {
  readonly nodes: readonly ArtifactNode[];
  readonly stage: number;
  readonly kind: string;
  readonly latestDraft: unknown;
}): ReviewableArtifact {
  const written = input.nodes
    .filter(
      (node) =>
        node.stage === input.stage &&
        node.kind === input.kind &&
        node.provenance.agentRole !== undefined &&
        node.supersededByNodeId === null,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (written) return { status: "found", node: written };
  if (input.latestDraft) return { status: "persist_needed" };
  return { status: "none" };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

/** The artifact's own `contentSha256` when the hub returns one, else the
 *  sha256 of `content` computed in the browser. */
export async function digestOf(content: string, contentSha256?: string | null): Promise<string> {
  if (contentSha256) return contentSha256;
  return sha256Hex(content);
}

async function decisionId(
  projectId: string,
  stage: number,
  artifactId: string,
  version: number,
  kind: string,
  epoch: number,
  attempt: number,
): Promise<string> {
  return `dec-${await sha256Hex(`${projectId}|${String(stage)}|${artifactId}|${String(version)}|${kind}|${String(epoch)}|${String(attempt)}`)}`;
}

export type StageApprovalDeps = {
  readonly view: (projectId: string) => Promise<ProjectWorkflowView | null>;
  readonly decide: (projectId: string, decision: Record<string, unknown>) => Promise<{ ok: true }>;
  readonly now: () => string;
};

export type StageApprovalResult = { readonly ok: true; readonly stage: number } | { readonly ok: false; readonly reason: string };

const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A signal delivery the hub already has a DIFFERENT payload recorded
 *  against (`decide`'s own doc comment in `client.ts`): distinguished from
 *  every other `decide` failure so a caller can treat it as a value rather
 *  than a thrown error. */
function isSignalIdConflict(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    (cause as { status: unknown }).status === 409 &&
    "code" in cause &&
    (cause as { code: unknown }).code === "signal_id_conflict"
  );
}

async function safeDecide(
  deps: StageApprovalDeps,
  projectId: string,
  decision: Record<string, unknown>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  try {
    return await deps.decide(projectId, decision);
  } catch (cause) {
    if (isSignalIdConflict(cause)) return { ok: false, reason: "signal_id_conflict" };
    throw cause;
  }
}

async function pollUntil(
  projectId: string,
  deps: StageApprovalDeps,
  fromStage: number,
  ourDecisionIds: ReadonlySet<string>,
): Promise<StageApprovalResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const view = await deps.view(projectId);
    if (view) {
      if (view.done || view.stage !== fromStage) return { ok: true, stage: view.stage };
      const refusal = findOurRefusal(view.decisions, ourDecisionIds);
      if (refusal) return { ok: false, reason: refusal.reason ?? "refused" };
    }
    if (Date.now() >= deadline) return { ok: false, reason: "timed_out" };
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Signals apply to the workflow's carried state asynchronously (a hub
 * `decide` answering success only means the signal was accepted for
 * delivery, not that the loop has processed it yet), so opening a review and
 * then reading the view once is a race. Polls (same bounds as `pollUntil`)
 * until the view's open review names exactly `ref`, or a refusal for one of
 * `ourDecisionIds` lands, or the timeout.
 */
async function pollForOpenReview(
  projectId: string,
  deps: StageApprovalDeps,
  ref: ArtifactRef,
  ourDecisionIds: ReadonlySet<string>,
): Promise<{ readonly ok: true; readonly review: ReviewState } | { readonly ok: false; readonly reason: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const view = await deps.view(projectId);
    if (view) {
      const review = view.openReview;
      if (review && review.artifactId === ref.artifactId && review.version === ref.version && review.sha256 === ref.sha256) {
        return { ok: true, review };
      }
      const refusal = findOurRefusal(view.decisions, ourDecisionIds);
      if (refusal) return { ok: false, reason: refusal.reason ?? "refused" };
    }
    if (Date.now() >= deadline) return { ok: false, reason: "timed_out" };
    await sleep(POLL_INTERVAL_MS);
  }
}

function findOurRefusal(decisions: readonly DecisionRecord[], ourDecisionIds: ReadonlySet<string>): DecisionRecord | null {
  return decisions.find((d) => !d.accepted && ourDecisionIds.has(d.decisionId)) ?? null;
}

export type EnsureReviewOpenInput = {
  readonly projectId: string;
  readonly stage: number;
  readonly ref: ArtifactRef;
  readonly attempt?: number;
  /** Stage 5 only: the quorum policy in effect right now, carried onto the
   *  `open_review` decision so the reducer captures it (CL-8870) -- an edit
   *  to the stakeholder list after this review opens can never change the
   *  gate it is checked against. */
  readonly policy?: AudiencePolicy;
};

export type EnsureReviewOpenResult =
  | { readonly ok: true; readonly review: ReviewState }
  | { readonly ok: false; readonly reason: string };

/**
 * Names `ref` as this stage's reviewable material unless a review is
 * already open under exactly that reference, and polls until the view
 * actually shows it open (a `decide` success only means the signal was
 * accepted, not applied yet). Idempotent under reload and two tabs:
 * `open_review` decision ids are deterministic from `(projectId, stage,
 * artifactId, version, epoch, attempt)`, so a second caller naming the same
 * ref against the same committed state re-derives the identical id and
 * either lands the same decision or gets back a normal `duplicate` refusal
 * -- never a second open review. Called both by `pages/workspace/index.tsx`
 * as soon as a stage's material appears (CL-8687 follow-up: the workflow,
 * not chat or artifact presence, is the only gate on approval) and by
 * `approveStage` below as a belt-and-braces fallback.
 */
export async function ensureReviewOpen(deps: StageApprovalDeps, input: EnsureReviewOpenInput): Promise<EnsureReviewOpenResult> {
  const attempt = input.attempt ?? 0;
  const view = await deps.view(input.projectId);
  if (!view) return { ok: false, reason: "workflow_unavailable" };
  if (view.stage !== input.stage) return { ok: false, reason: "wrong_stage" };
  const epoch = view.decisions.length;

  const sameRef = view.openReview !== null && view.openReview.artifactId === input.ref.artifactId && view.openReview.version === input.ref.version && view.openReview.sha256 === input.ref.sha256;
  if (sameRef) return { ok: true, review: view.openReview! };

  const ourDecisionIds = new Set<string>();
  const openId = await decisionId(input.projectId, input.stage, input.ref.artifactId, input.ref.version, "open_review", epoch, attempt);
  ourDecisionIds.add(openId);
  const sent = await safeDecide(deps, input.projectId, {
    kind: "open_review",
    decisionId: openId,
    projectId: input.projectId,
    stage: input.stage,
    artifactId: input.ref.artifactId,
    version: input.ref.version,
    sha256: input.ref.sha256,
    at: deps.now(),
    ...(input.policy ? { policy: input.policy } : {}),
  });
  if (!sent.ok) return sent;

  return pollForOpenReview(input.projectId, deps, input.ref, ourDecisionIds);
}

export type ApproveStageInput = {
  readonly projectId: string;
  readonly stage: number;
  readonly ref: ArtifactRef;
  readonly attempt?: number;
  /** Stage-rule input (stage 7's freeze); never read here, only forwarded on
   *  the `approve` decision. Does not affect id derivation. */
  readonly evidence?: unknown;
  /** Stage 5 only: forwarded to `ensureReviewOpen`'s belt-and-braces open --
   *  see that input's own doc comment. */
  readonly policy?: AudiencePolicy;
};

/**
 * Ensures a review is open naming `ref` (belt and braces -- the normal path
 * is that `pages/workspace/index.tsx` already opened it the moment the
 * material appeared, so this is a no-op refusal-free call), approves it,
 * then polls (bounded) until the stage advances/the project is done, or one
 * of THIS call's decisions comes back refused.
 */
export async function approveStage(deps: StageApprovalDeps, input: ApproveStageInput): Promise<StageApprovalResult> {
  const attempt = input.attempt ?? 0;
  const view = await deps.view(input.projectId);
  if (!view) return { ok: false, reason: "workflow_unavailable" };
  if (view.stage !== input.stage) return { ok: false, reason: "wrong_stage" };
  const epoch = view.decisions.length;

  const opened = await ensureReviewOpen(deps, {
    projectId: input.projectId,
    stage: input.stage,
    ref: input.ref,
    attempt,
    ...(input.policy ? { policy: input.policy } : {}),
  });
  if (!opened.ok) return opened;
  const review = opened.review;

  const ourDecisionIds = new Set<string>();
  const approveId = await decisionId(input.projectId, input.stage, input.ref.artifactId, input.ref.version, "approve", epoch, attempt);
  ourDecisionIds.add(approveId);
  const sentApprove = await safeDecide(deps, input.projectId, {
    kind: "approve",
    decisionId: approveId,
    projectId: input.projectId,
    stage: input.stage,
    reviewId: review.reviewId,
    artifactId: input.ref.artifactId,
    version: input.ref.version,
    sha256: input.ref.sha256,
    at: deps.now(),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  if (!sentApprove.ok) return sentApprove;

  return pollUntil(input.projectId, deps, input.stage, ourDecisionIds);
}

export type MintRequirementsInput = {
  readonly projectId: string;
  readonly stage: number;
  readonly items: readonly { readonly kind: string; readonly text: string }[];
  readonly attempt?: number;
};

export type MintRequirementsResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Mints `ProjectState.requirements` from `items` (`P/requirements.ts`'s
 * `extractRequirementItems`), once, before the Architect drafts. Idempotent
 * from the caller's point of view: already-minted requirements -- this
 * session's own earlier call, another tab, or a retry -- is `ok: true`,
 * whether the view already shows them or the workflow refuses with
 * `requirements_already_minted`; neither is an error the UI should show.
 */
export async function mintRequirements(deps: StageApprovalDeps, input: MintRequirementsInput): Promise<MintRequirementsResult> {
  const attempt = input.attempt ?? 0;
  const view = await deps.view(input.projectId);
  if (!view) return { ok: false, reason: "workflow_unavailable" };
  if (view.requirements.length > 0) return { ok: true };
  if (view.stage !== input.stage) return { ok: false, reason: "wrong_stage" };
  const epoch = view.decisions.length;
  const id = `dec-${await sha256Hex(`${input.projectId}|${String(input.stage)}|mint_requirements|${String(epoch)}|${String(attempt)}`)}`;
  const ourDecisionIds = new Set<string>([id]);
  const sent = await safeDecide(deps, input.projectId, {
    kind: "mint_requirements",
    decisionId: id,
    projectId: input.projectId,
    stage: input.stage,
    items: input.items,
    at: deps.now(),
  });
  if (!sent.ok) return sent;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const polled = await deps.view(input.projectId);
    if (polled) {
      if (polled.requirements.length > 0) return { ok: true };
      const refusal = findOurRefusal(polled.decisions, ourDecisionIds);
      if (refusal) {
        if (refusal.reason === "requirements_already_minted") return { ok: true };
        return { ok: false, reason: refusal.reason ?? "refused" };
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason: "timed_out" };
    await sleep(POLL_INTERVAL_MS);
  }
}

export type SendBackInput = {
  readonly projectId: string;
  readonly stage: number;
  readonly targetStage: number;
  readonly reason: string;
  readonly attempt?: number;
};

export async function sendBack(deps: StageApprovalDeps, input: SendBackInput): Promise<StageApprovalResult> {
  const attempt = input.attempt ?? 0;
  const view = await deps.view(input.projectId);
  if (!view) return { ok: false, reason: "workflow_unavailable" };
  const epoch = view.decisions.length;
  const id = await decisionId(input.projectId, input.stage, "send_back", input.targetStage, "send_back", epoch, attempt);
  const ourDecisionIds = new Set<string>([id]);
  const sent = await safeDecide(deps, input.projectId, {
    kind: "send_back",
    decisionId: id,
    projectId: input.projectId,
    stage: input.stage,
    targetStage: input.targetStage,
    reason: input.reason,
    at: deps.now(),
  });
  if (!sent.ok) return sent;
  return pollUntil(input.projectId, deps, input.stage, ourDecisionIds);
}

export type RecordAudienceVoteInput = {
  readonly projectId: string;
  readonly stage: number;
  readonly audience: string;
  readonly decision: "proceed" | "revise" | "reject";
  readonly note?: string;
  readonly decisionId: string;
};

export type RecordAudienceVoteResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Records one stakeholder's own proceed/revise/reject as the loop's own
 * `project.decision` `audience` signal (CL-8870) -- the mail-agent-shaped
 * replacement for the deleted `recordAudienceDecision` artifact-metadata
 * write. Polls (same bounds as the other stage decisions) until the
 * workflow's own view shows this exact `decisionId` recorded against that
 * audience, or a refusal for it lands.
 */
export async function recordAudienceVote(deps: StageApprovalDeps, input: RecordAudienceVoteInput): Promise<RecordAudienceVoteResult> {
  const ourDecisionIds = new Set<string>([input.decisionId]);
  const sent = await safeDecide(deps, input.projectId, {
    kind: "audience",
    decisionId: input.decisionId,
    projectId: input.projectId,
    stage: input.stage,
    audience: input.audience,
    decision: input.decision,
    at: deps.now(),
    ...(input.note ? { note: input.note } : {}),
  });
  if (!sent.ok) return sent;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const view = await deps.view(input.projectId);
    if (view) {
      if (view.audienceDecisions[input.audience]?.decisionId === input.decisionId) return { ok: true };
      const refusal = findOurRefusal(view.decisions, ourDecisionIds);
      if (refusal) return { ok: false, reason: refusal.reason ?? "refused" };
    }
    if (Date.now() >= deadline) return { ok: false, reason: "timed_out" };
    await sleep(POLL_INTERVAL_MS);
  }
}
