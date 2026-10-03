/**
 * The senior-engineer panel as a companion (#341): four independent
 * principals, each a real, lazily deployed agent with its own thread,
 * asked only on an explicit click against the stage's input. Stage 6 asks
 * them about the plan (`stage6.tsx` carries its own copy of this logic
 * beside the requirements author); stage 8 asks them about the build's
 * evidence. A reply is recorded as the project's review document for that
 * reviewer, recorded reviews are read back on a reload, and the companion
 * shows the one chosen with Copy and Export.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ArtifactNode } from "../../client.js";
import { useWaitingReplies } from "./use-waiting-replies.ts";
import { Markdown } from "../../markdown.jsx";
import { Banner, Button, CopyButton } from "../../components.jsx";
import { DocumentExportMenu, draftNode } from "../../document-export.jsx";
import { reviewDocument, type StageDocument } from "./document-mentions.ts";
import { stageName } from "../../stage-names.ts";

export const PANEL_ROLES: readonly { key: string; label: string }[] = [
  { key: "application", label: "Application" },
  { key: "quality", label: "Quality" },
  { key: "platform", label: "Platform" },
  { key: "security", label: "Security" },
];

export type PanelReviewState = {
  status: "idle" | "starting" | "waiting" | "done" | "error";
  address: string | null;
  reply: string | null;
  error: string | null;
  requestedAt: number;
  /** The reply is the project's recorded document already, not a fresh one to record. */
  recorded: boolean;
};

const IDLE: PanelReviewState = { status: "idle", address: null, reply: null, error: null, requestedAt: 0, recorded: false };

/** The recorded reviews of a stage, newest unsuperseded version per reviewer. */
export function reviewNodesOf(nodes: readonly ArtifactNode[], stage: 6 | 8): ReadonlyMap<string, ArtifactNode> {
  const kind = stage === 8 ? "build_review" : "engineering_review";
  const byReviewer = new Map<string, ArtifactNode>();
  for (const node of nodes) {
    if (node.kind !== kind || node.stage !== stage || node.supersededByNodeId !== null || !node.variant) continue;
    const held = byReviewer.get(node.variant);
    if (!held || node.version > held.version) byReviewer.set(node.variant, node);
  }
  return byReviewer;
}

export function usePanelReviews({
  projectId,
  tenantId,
  stage,
  reviewInput,
  reviewNodes,
  onDocumentsChanged,
}: {
  projectId: string;
  tenantId: string;
  stage: 6 | 8;
  /** What a review is asked against; null until the stage has it. */
  reviewInput: string | null;
  reviewNodes: ReadonlyMap<string, ArtifactNode>;
  onDocumentsChanged?: () => void;
}) {
  const [reviews, setReviews] = useState<Record<string, PanelReviewState>>({});
  const update = useCallback((roleKey: string, updater: (prev: PanelReviewState) => PanelReviewState) => {
    setReviews((prev) => ({ ...prev, [roleKey]: updater(prev[roleKey] ?? IDLE) }));
  }, []);

  const requestReview = useCallback(
    (roleKey: string) => {
      if (!reviewInput) return;
      update(roleKey, (prev) => ({ ...prev, status: "starting", error: null, recorded: false }));
      void (async () => {
        try {
          const deployment = await api.ensureStageRoleAgent(projectId, stage, roleKey);
          const requestedAt = Date.now();
          update(roleKey, (prev) => ({ ...prev, address: deployment.address, status: "waiting", requestedAt }));
          await api.sendStageMail(tenantId, deployment.address, { body: reviewInput });
        } catch (cause) {
          update(roleKey, (prev) => ({ ...prev, status: "error", error: cause instanceof ApiFailure ? cause.detail.message : String(cause) }));
        }
      })();
    },
    [projectId, stage, tenantId, reviewInput, update],
  );

  // A recorded review is read back on a reload.
  const recoveredFor = useRef(new Set<string>());
  useEffect(() => {
    for (const role of PANEL_ROLES) {
      if ((reviews[role.key] ?? IDLE).status !== "idle") continue;
      const node = reviewNodes.get(role.label);
      if (!node || recoveredFor.current.has(node.id)) continue;
      recoveredFor.current.add(node.id);
      void api
        .artifactContent(tenantId, node.id)
        .then((result) =>
          update(role.key, (prev) => (prev.status === "idle" ? { ...prev, status: "done", reply: result.content, recorded: true } : prev)),
        )
        .catch(() => undefined);
    }
  }, [reviews, reviewNodes, tenantId, update]);

  // A reply that lands is recorded as the project's document.
  const recordedFor = useRef(new Set<string>());
  useEffect(() => {
    for (const role of PANEL_ROLES) {
      const state = reviews[role.key];
      if (!state || state.status !== "done" || !state.reply || state.recorded) continue;
      const mark = `${role.key}:${String(state.requestedAt)}:${String(state.reply.length)}`;
      if (recordedFor.current.has(mark)) continue;
      recordedFor.current.add(mark);
      const reply = state.reply;
      void api
        .persistPanelReview(projectId, stage, role.key, role.label, reply)
        .then(() => {
          update(role.key, (prev) => (prev.reply === reply ? { ...prev, recorded: true } : prev));
          onDocumentsChanged?.();
        })
        .catch(() => undefined);
    }
  }, [reviews, projectId, stage, onDocumentsChanged, update]);

  // Waiting reviews read their thread back: a mailbox nudge wakes this at
  // once and an interval backstops a missed one; nothing is resent.
  const waiting = PANEL_ROLES.flatMap((role) => {
    const state = reviews[role.key];
    return state?.status === "waiting" && state.address ? [{ key: role.key, address: state.address, requestedAt: state.requestedAt }] : [];
  });
  useWaitingReplies(
    tenantId,
    waiting,
    (key, reply) => update(key, (prev) => (prev.status === "waiting" ? { ...prev, status: "done", reply } : prev)),
    (key, error) => update(key, (prev) => (prev.status === "waiting" ? { ...prev, status: "error", error } : prev)),
  );

  return { reviews, requestReview, stateOf: (roleKey: string) => reviews[roleKey] ?? IDLE };
}

/** What the companion says of the chosen review. */
export function panelReviewMeta(state: Pick<PanelReviewState, "status">, hasInput: boolean): string {
  if (state.status === "starting" || state.status === "waiting") return "drafting";
  if (state.status === "done") return "draft";
  if (state.status === "error") return "failed";
  return hasInput ? "not yet requested" : "waiting on build evidence";
}

/**
 * Stage 8's reviews companion (#341): a reviewer picker, Request review,
 * and the chosen review folded under the build pane, the same card stage 6
 * uses for its companion.
 */
export function PanelReviewsCompanion({
  projectId,
  tenantId,
  stage,
  reviewInput,
  reviewNodes,
  onDocumentsChanged,
  onDocuments,
}: {
  projectId: string;
  tenantId: string;
  stage: 6 | 8;
  reviewInput: string | null;
  reviewNodes: ReadonlyMap<string, ArtifactNode>;
  onDocumentsChanged?: () => void;
  /** The reviews as they stand, as documents a message to the stage's specialist may attach. */
  onDocuments?: (documents: StageDocument[]) => void;
}) {
  const panel = usePanelReviews({ projectId, tenantId, stage, reviewInput, reviewNodes, ...(onDocumentsChanged ? { onDocumentsChanged } : {}) });
  const [page, setPage] = useState(PANEL_ROLES[0]!.key);
  const documents = PANEL_ROLES.flatMap((role) => {
    const state = panel.stateOf(role.key);
    return state.status === "done" && state.reply ? [reviewDocument(role.label, state.reply, stage === 8 ? "build-review" : "review")] : [];
  });
  const documentsKey = documents.map((doc) => `${doc.key}:${String(doc.content.length)}`).join("|");
  useEffect(() => {
    onDocuments?.(documents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentsKey]);
  const role = PANEL_ROLES.find((entry) => entry.key === page) ?? PANEL_ROLES[0]!;
  const current = panel.stateOf(role.key);
  const busy = current.status === "starting" || current.status === "waiting";
  const kind = stage === 8 ? "build_review" : "engineering_review";
  return (
    <div className="stage6-companion">
      <div className="docmeta">
        <select aria-label={`${stageName(stage)} review`} value={page} onChange={(event) => setPage(event.target.value)}>
          {PANEL_ROLES.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label} review
            </option>
          ))}
        </select>
        <span className="inline-note">{panelReviewMeta(current, reviewInput !== null)}</span>
        <Button variant="ghost" loading={busy} disabled={!reviewInput || busy} onClick={() => panel.requestReview(role.key)}>
          {current.status === "done" ? "Request again" : "Request review"}
        </Button>
        {current.status === "done" && current.reply ? (
          <>
            <CopyButton text={current.reply} />
            <DocumentExportMenu node={draftNode(kind, stage, `${role.label} review`)} tenantId={tenantId} content={current.reply} />
          </>
        ) : null}
      </div>
      {current.status === "error" ? (
        <Banner tone="error" title="This review could not be completed">
          {current.error}
        </Banner>
      ) : null}
      {current.status === "done" && current.reply ? (
        <details className="document-fold">
          <summary className="document-fold-summary">
            <span className="document-fold-title">{role.label} review</span>
          </summary>
          <div className="document-fold-body">
            <Markdown source={current.reply} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
