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
import type { DecisionRecord, ReviewState } from "@solutions-builder/app/project-workflow/contracts";
import type { ArtifactNode } from "./client.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";

export type ArtifactRef = {
  readonly artifactId: string;
  readonly version: number;
  readonly sha256: string;
};

export type ReviewableArtifact = { readonly status: "found"; readonly node: ArtifactNode } | { readonly status: "persist_needed" } | { readonly status: "none" };

/**
 * A stage's reviewable artifact. In tonight's live proof the specialist did
 * not call `artifact_create` itself, so the path that actually runs is the
 * fallback: the browser persists the latest substantial chat draft as a new
 * version (`pages/workspace/index.tsx`'s `approve()`, via
 * `persistStageDraft`/`persistBuildEvidence`, stamping no `approvedAt` any
 * more -- CL-8687), and THAT reference is what goes into `open_review`.
 *
 * Preferring an artifact the specialist wrote directly (`source.origin ===
 * "workflow"`, scoped to this project's stage-N specialist deployment) would
 * need the specialist deployment listing threaded in here as IO, and every
 * specialist-written artifact today carries no `metadata.sb` to key it back
 * to a project/stage by anyway -- so that branch is intentionally left
 * un-implemented (`"found"` is never returned) rather than matched on a
 * signal (`provenance.producer`) that does not actually distinguish it.
 */
export function reviewableArtifact(input: {
  readonly nodes: readonly ArtifactNode[];
  readonly stage: number;
  readonly kind: string;
  readonly latestDraft: unknown;
}): ReviewableArtifact {
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

export type ApproveStageInput = {
  readonly projectId: string;
  readonly stage: number;
  readonly ref: ArtifactRef;
  readonly attempt?: number;
};

/**
 * Reads the current view; opens a review naming `ref` unless one is already
 * open under exactly that reference, and polls until the view actually
 * shows it open (a `decide` success only means the signal was accepted, not
 * applied); approves it; polls (bounded) until the stage advances/the
 * project is done, or one of THIS call's decisions comes back refused.
 */
export async function approveStage(deps: StageApprovalDeps, input: ApproveStageInput): Promise<StageApprovalResult> {
  const attempt = input.attempt ?? 0;
  const view = await deps.view(input.projectId);
  if (!view) return { ok: false, reason: "workflow_unavailable" };
  if (view.stage !== input.stage) return { ok: false, reason: "wrong_stage" };
  const epoch = view.decisions.length;

  const ourDecisionIds = new Set<string>();
  const sameRef = view.openReview !== null && view.openReview.artifactId === input.ref.artifactId && view.openReview.version === input.ref.version && view.openReview.sha256 === input.ref.sha256;

  let review: ReviewState;
  if (sameRef) {
    review = view.openReview!;
  } else {
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
    });
    if (!sent.ok) return sent;

    const opened = await pollForOpenReview(input.projectId, deps, input.ref, ourDecisionIds);
    if (!opened.ok) return opened;
    review = opened.review;
  }

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
  });
  if (!sentApprove.ok) return sentApprove;

  return pollUntil(input.projectId, deps, input.stage, ourDecisionIds);
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
