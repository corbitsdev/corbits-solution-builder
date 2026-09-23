/**
 * The stage workspace.
 *
 * A stage is a document someone has to read and react to, so the document is
 * the page. Before one exists there is a single question and nothing else;
 * once one exists the draft box is gone and the document takes the room, with
 * the conversation that produced it alongside.
 *
 * Reacting to a document means saying what is wrong with a specific part of
 * it, so selecting text in the document opens a comment on that passage.
 * Comments queue rather than sending one at a time — a reader marks up a whole
 * draft and then hands it back, which is both how people actually read and the
 * only way the specialist sees the notes as one coherent set.
 *
 * The file itself is orchestration only: each stateful concern lives in a
 * `use-*.ts` hook beside it (workflow view, specialist, thread, withdrawn
 * turns, opening dispatch, advisories, document versions, gate decisions),
 * and each render block a focused component (`workspace-chrome.tsx`). What
 * stays here is the wiring between them and the stage-specific composition.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiFailure,
  type ArtifactNode,
  type ProjectDetail,
  type StageTurn,
} from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { Markdown } from "../../markdown.jsx";
import { AudiencePackages } from "../audiences.jsx";
import { DesignFeedbackView } from "../design.jsx";
import { Tabs } from "@corbits/react-ui";
import { Banner, Button, Screen, StateLabel, stageName, versionDigest } from "../../components.jsx";
import { DeliveryPanel } from "./delivery.jsx";
import { StageConversation } from "./thread.jsx";
import { StageDocument } from "./document.jsx";
import { BuildPanel } from "./build.jsx";
import { TargetPicker } from "./freeze.jsx";
import { EstimateView } from "./estimate.jsx";
import { interviewProgress, workspaceGuidance } from "./guidance.js";
import { useWorkflowView } from "./use-workflow-view.ts";
import { useStageAgent } from "./use-stage-agent.ts";
import { useStageThread } from "./use-stage-thread.ts";
import { useWithdrawnTurns } from "./use-withdrawn-turns.ts";
import { useOpeningDispatch } from "./use-opening-dispatch.ts";
import { useProjectArtifacts } from "./use-project-artifacts.ts";
import { loadQuotedDraft } from "./quote-store.js";
import { useStageDecisions } from "./use-stage-decisions.ts";
import { ArtifactStrip, VersionStrip } from "./artifact-strip.tsx";
import { stageEvents } from "./stage-events.ts";
import { Stage6Panel } from "./stage6.tsx";
import { renderRequirementsBlock } from "@solutions-builder/app/requirements";
import { agentFor } from "@solutions-builder/app/kit";
import type { Stage } from "@solutions-builder/app/ledger";
import { STAGE_DRAFT_KIND } from "../../client.js";
import {
  OpeningScreen,
  SendBackPopover,
  StagePanes,
} from "./workspace-chrome.tsx";
import type { FoldedFeedback } from "@solutions-builder/app/project-state";

export { StageDocument, DocumentBody } from "./document.jsx";
export { ApprovalsRecord, STAGE_GOAL } from "./gate.jsx";

/** Stages whose draft is prose read in the two-pane document, rather than
 * one of the specialised panels (design, audiences, build) or the final
 * decisions stage. */
const DOCUMENT_STAGES = new Set([1, 2, 3, 6, 7]);

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

export function StageWorkspace({
  detail,
  tenantId,
  onChanged,
  onOpenSettings,
  draftOpen = true,
  onOpenDecisions,
  focusArtifact,
}: {
  detail: ProjectDetail;
  /**
   * Accepted for compatibility with callers still on the pre-mail-chat
   * shape; unused here — the mail-chat contract (CL-8612) has no lifecycle
   * run to fold a position from, no draft/versions split, and stage 9's
   * decisions live entirely in the existing approvals UI, not this page.
   */
  standing?: unknown;
  draftOpen?: boolean;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  onOpenSettings: () => void;
  onOpenDecisions?: () => void;
  /** A done-segment click: open that stage's newest artifact tab. `at` makes
   *  a repeat click on the same stage a fresh signal. */
  focusArtifact?: { readonly stage: number; readonly at: number };
}) {
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<
    import("../../client.js").Remediation | undefined
  >(undefined);

  const workflow = useWorkflowView(detail.project.id, onChanged);
  const workflowView = workflow.view;
  const workflowResolved = workflow.resolved;
  const openingFailed = workflow.openingFailed;
  const stage = workflowView?.stage ?? 1;

  const agent = useStageAgent(detail.project.id, stage, workflowResolved);
  const agentAddress = agent.address;
  // Stable across renders — an inline arrow would re-subscribe the mailbox
  // stream every render since it is a dep of the thread effect.
  const nudgeWorkflow = useCallback(() => void workflow.reload(), [workflow.reload]);
  const thread = useStageThread(tenantId, agentAddress, nudgeWorkflow, setError);
  const loadThread = thread.reload;

  // What Stop put back into the box: the composer below for a plain-chat
  // stage, and this seed for the document composer's own local state.
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [stopSeed, setStopSeed] = useState<{ text: string; at: number } | null>(null);

  const withdrawn = useWithdrawnTurns(
    detail.project.id,
    tenantId,
    stage,
    detail.nodes,
    thread.messages,
    (body) => {
      setComposer(body);
      setStopSeed({ text: body, at: Date.now() });
    },
    setError,
  );
  const foldedMessages = withdrawn.messages;
  const withdrawnIds = withdrawn.ids;
  const pending = withdrawn.pending;
  const stopTurn = withdrawn.stop;

  const openingDispatch = useOpeningDispatch({
    detail,
    tenantId,
    stage,
    agentAddress,
    messages: thread.messages,
    loadedFor: thread.loadedFor,
    workflowView,
    reloadThread: loadThread,
  });

  // Withdrawn turns are folded out before anything below reads the thread,
  // so a reply Stop hid can never surface as the latest turn, the draft, or
  // the open question (CL-8695).
  const latestSpecialistMessage = [...foldedMessages].reverse().find((message) => message.author === "agent") ?? null;
  // Mail has no separate draft record before approval. Keep a substantial
  // draft separate from the latest conversational turn so an acknowledgement
  // or a follow-up question never replaces the document being reviewed.
  const guidance = useMemo(() => workspaceGuidance(stage, foldedMessages), [stage, foldedMessages]);
  const draftMessage = guidance.draft;
  const reviewMessage = DOCUMENT_STAGES.has(stage) ? draftMessage : latestSpecialistMessage;
  const progress = useMemo(() => interviewProgress(foldedMessages), [foldedMessages]);

  const lastPersonMessage = [...foldedMessages].reverse().find((message) => message.author === "me") ?? null;

  // Mail turns as StageDocument's turn shape: it wants who spoke and what
  // was said, nothing this contract tracks beyond that (no per-turn quotes
  // or result-node bookkeeping under mail-chat).
  const turns: StageTurn[] = useMemo(
    () =>
      foldedMessages.map((message) => ({
        id: message.id,
        role: message.author === "me" ? "human" : "specialist",
        body: message.body,
        quotes: [],
        resultNodeId: null,
        questions: null,
        createdAt: message.at,
      })),
    [foldedMessages],
  );

  const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
  const artifacts = useProjectArtifacts(tenantId, stage, detail.nodes, draftMessage);
  // A done-segment click is a navigation signal, not state — one effect is
  // where it lands.
  useEffect(() => {
    if (focusArtifact) artifacts.selectStage(focusArtifact.stage);
    // `at` is the nonce; the tabs/artifacts identity is intentionally out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusArtifact?.at]);
  // The transcript's quiet record: boundaries, versions, decisions and
  // aborted turns, folded in beside the mail as system lines.
  const events = useMemo(
    () => stageEvents(stage, workflowView?.decisions ?? [], detail.nodes, withdrawn.marks),
    [stage, workflowView?.decisions, detail.nodes, withdrawn.marks],
  );
  const decisions = useStageDecisions({
    detail,
    tenantId,
    stage,
    workflowView,
    reviewMessage,
    draftKind,
    foldedMessages,
    refreshWorkflow: workflow.refresh,
    markStage: workflow.markStage,
    queueOpening: openingDispatch.queueOpening,
    onError: setError,
    onRemediation: setRemediation,
  });
  const {
    approve,
    acceptDelivery,
    approveAllowed,
    approving,
    openReviewNow,
    chosenTarget,
    setChosenTarget,
    sendBack,
    setSendReason,
    mintRequirements,
  } = decisions;
  const refreshWorkflow = workflow.refresh;

  // Holding send raises the send-back picker over the composer; whatever is
  // typed goes along as the reason. The full picker also lives in Guidance —
  // a hold gesture is invisible to keyboard and discovery both.
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const openSendBack = (draft: string) => {
    // Queued passages lead the reason — the send-back is what they were
    // attached for, so they go whether or not a note was typed.
    const passages = loadQuotedDraft(tenantId, stage).map(
      (entry) => `> ${entry.note ? `${entry.quote}\n— ${entry.note}` : entry.quote}`,
    );
    const reason = [...passages, draft.trim()].filter(Boolean).join("\n\n");
    if (reason) setSendReason(reason);
    setSendBackOpen(true);
  };
  const sendBackPopover = (
    <SendBackPopover
      stage={stage}
      open={sendBackOpen}
      onDismiss={() => setSendBackOpen(false)}
      onPick={(target) => {
        setSendBackOpen(false);
        void sendBack(target);
      }}
    />
  );

  // Reading a superseded version of the stage's draft: the gate swaps
  // approve for "make this the active version" — restoring writes the old
  // content forward as the new head, versions are append-only.
  const [promoting, setPromoting] = useState(false);
  const superseded =
    artifacts.isStageDraft && artifacts.selected !== null && artifacts.activeNode !== null &&
    artifacts.activeNode !== artifacts.selected.versions.at(-1);
  const promote = async () => {
    if (!artifacts.activeContent || !superseded) return;
    setPromoting(true);
    setError(null);
    try {
      const materials = detail.nodes.filter((node) => node.kind === "source_material").map((node) => node.id);
      await api.persistStageDraft(detail.project.id, stage, artifacts.activeContent, materials);
      await refreshWorkflow();
      artifacts.select(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setPromoting(false);
    }
  };

  const send = async (body: string) => {
    if (!agentAddress || body.trim().length === 0) return;
    setSending(true);
    setError(null);
    setRemediation(undefined);
    try {
      await api.sendStageMail(tenantId, agentAddress, { body });
      await loadThread();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setSending(false);
    }
  };

  // Neutral until the workflow view says which stage this really is — never
  // the artifact-derived fallback, which for a mid-way project is stage 1
  // and would otherwise flash before the real stage takes over (CL-8721).
  if (!workflowResolved && !openingFailed) {
    return <OpeningScreen />;
  }

  // The strip and conversation are the same on every stage; only the right
  // pane's surface changes. Selecting a tab for another stage reads that
  // artifact — the stage's own surface only owns its own tab.
  const stripEl = artifacts.selected ? (
    <>
      <ArtifactStrip
        tabs={artifacts.tabs}
        selectedKey={artifacts.selected.key}
        onSelect={artifacts.select}
      />
      {artifacts.activeNode ? (
        <VersionStrip
          tab={artifacts.selected}
          activeId={artifacts.activeNode.id}
          onSelect={artifacts.selectVersion}
        />
      ) : null}
    </>
  ) : null;

  const reader =
    artifacts.selected !== null && artifacts.selected.stage !== stage && artifacts.activeNode ? (
      <div className="stage-inner">
        <div className="doc">
          <div className="docmeta">
            <span>
              {artifacts.activeNode.title} · v{artifacts.activeNode.version} · stage{" "}
              {artifacts.activeNode.stage}
              {artifacts.activeNode.supersededByNodeId ? " · superseded" : ""}
            </span>
          </div>
          {artifacts.activeContent ? (
            <Markdown source={artifacts.activeContent} />
          ) : (
            <p className="inline-note">Loading…</p>
          )}
        </div>
      </div>
    ) : null;

  const conversation = (
    <StageConversation
      stage={stage}
      messages={foldedMessages}
      value={composer}
      onValueChange={setComposer}
      onSend={() => {
        const body = composer;
        setComposer("");
        void send(body);
      }}
      working={sending}
      disabled={!agentAddress}
      withdrawnIds={withdrawnIds}
      pending={pending !== null}
      onStop={() => void stopTurn()}
      onSendHold={() => openSendBack(composer)}
      popover={sendBackPopover}
      events={events}
      who={stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title : "Specialist"}
      placeholder={`Message the ${stage >= 1 && stage <= 9 ? agentFor(stage as Stage).title.toLowerCase() : "specialist"}…`}
      onAttach={(files) => {
        void api.attachMaterial(detail.project.id, [...files]).then(() => void refreshWorkflow());
      }}
    />
  );

  return (
    <div className="stage-view">
      {workflowView?.done ? (
        <Banner tone="okay" title="This project is delivered — stage 9's approval was recorded and the workflow has finished." />
      ) : null}

      {openingFailed ? (
        <Banner
          tone="error"
          title={
            workflow.startError
              ? `The project workflow could not be started: ${workflow.startError}`
              : "The project workflow could not be read."
          }
          action={{ label: "Try again", onClick: workflow.retryOpening }}
        />
      ) : null}

      {error ? (
        <Banner
          tone="error"
          title={error}
          {...(remediation
            ? {
                action: {
                  label: remediation.label,
                  onClick: () => {
                    if (remediation.kind === "retry") {
                      setError(null);
                      setRemediation(undefined);
                      return;
                    }
                    onOpenSettings();
                  },
                },
              }
            : {})}
        />
      ) : null}

      {!agentAddress && agent.error ? (
        <Banner
          tone="error"
          title={`The ${stageName(stage).toLowerCase()} specialist could not be started`}
          action={{ label: "Try again", onClick: agent.retry }}
        >
          {agent.error}
        </Banner>
      ) : null}

      {!agentAddress && !agent.error ? <OpeningScreen /> : null}

      {agentAddress && openingDispatch.error ? (
        <Banner
          tone="error"
          title="The opening message could not be sent"
          action={{ label: "Try again", onClick: openingDispatch.retry }}
        >
          {openingDispatch.error}
        </Banner>
      ) : null}

      {agentAddress && stage === 4 ? (
        <StagePanes strip={stripEl} conversation={conversation}>
          {reader ?? (
            <DesignPanel
              detail={detail}
              tenantId={tenantId}
              onChanged={() => void refreshWorkflow()}
              onApprove={approve}
              onRevise={(prompt) => send(prompt)}
              latestReply={latestSpecialistMessage}
              canApprove={approveAllowed}
            />
          )}
        </StagePanes>
      ) : null}

      {agentAddress && stage === 5 ? (
        <StagePanes strip={stripEl} conversation={conversation}>
          {reader ?? (
            <div className="stage-inner">
              <AudiencePackages
                detail={detail}
                tenantId={tenantId}
                onChanged={() => {
                  void refreshWorkflow();
                  void loadThread();
                }}
                onApprove={approve}
                approving={approving || workflow.refreshingAfterAction}
                canApprove={approveAllowed}
                approveReason={workflowView?.allowed.approveReason ?? null}
                lastRefusal={workflowView?.lastRefusal ?? null}
                workflowView={workflowView}
              />
            </div>
          )}
        </StagePanes>
      ) : null}

      {agentAddress && stage === 8 ? (
        <BuildPanel
          detail={detail}
          tenantId={tenantId}
          onChanged={() => void refreshWorkflow()}
          onOpenSettings={onOpenSettings}
          onApprove={approve}
          approving={approving || workflow.refreshingAfterAction}
          canApprove={approveAllowed}
          onAcceptEvidence={openReviewNow}
          {...(onOpenDecisions ? { onOpenDecisions } : {})}
          strip={stripEl}
          reader={reader}
          stageEvents={events}
          onSendHold={openSendBack}
          popover={sendBackPopover}
          onAttach={(files) => {
            void api.attachMaterial(detail.project.id, [...files]).then(() => void refreshWorkflow());
          }}
        />
      ) : null}

      {agentAddress && stage === 6 ? (
        <Stage6Panel
          tenantId={tenantId}
          projectId={detail.project.id}
          requirementsInput={lastPersonMessage?.body ?? null}
          reviewInput={draftMessage?.body ?? null}
          requirementsBlock={workflowView ? renderRequirementsBlock(workflowView.requirements) : null}
          onRequirementsDrafted={mintRequirements}
          strip={stripEl}
          conversation={conversation}
          reader={reader}
          pane={!(draftMessage && artifacts.activeNode && artifacts.selected)}
        />
      ) : null}

      {agentAddress && DOCUMENT_STAGES.has(stage) && stage !== 6 && !draftMessage ? (
        <StagePanes
          strip={stripEl}
          conversation={conversation}
        >
          {reader}
        </StagePanes>
      ) : null}

      {agentAddress && DOCUMENT_STAGES.has(stage) && draftMessage && artifacts.activeNode && artifacts.selected ? (
        <>
          {stage === 7 ? (
            <EstimateView
              body={draftMessage.body}
              chosenTarget={chosenTarget}
              freeze={workflowView?.freeze ?? null}
            />
          ) : null}
          {stage === 7 ? <TargetPicker chosen={chosenTarget} onChange={setChosenTarget} /> : null}
          <StageDocument
            node={artifacts.activeNode}
            versions={artifacts.selected.versions}
            content={artifacts.activeContent}
            tenantId={tenantId}
            turns={turns}
            openQuestion={
              guidance.question
                ? { text: guidance.question.text, ordinal: progress?.ordinal ?? null, total: progress?.total ?? null }
                : null
            }
            onSelectVersion={artifacts.selectVersion}
            onRevise={(message, quotes) => {
              artifacts.selectVersion(null);
              const quoted = quotes.map((entry) => `> ${entry.quote}`).join("\n");
              void send(quoted ? `${quoted}\n\n${message}` : message);
            }}
            onAddMaterial={async (files) => {
              await api.attachMaterial(detail.project.id, files);
              void refreshWorkflow();
            }}
            onSubmit={() => void approve()}
            soloApproval={detail.soloApproval}
            canSubmit={approveAllowed && artifacts.isStageDraft && !superseded}
            busy={sending ? "draft" : approving || workflow.refreshingAfterAction ? "submit" : null}
            draftOpen={draftOpen}
            newer={artifacts.newerVersion}
            live={null}
            seed={stopSeed}
            withdrawnIds={withdrawnIds}
            pending={pending !== null}
            onStop={() => void stopTurn()}
            onSendHold={openSendBack}
            composerPopover={sendBackPopover}
            events={events}
            strip={stripEl}
            promote={
              superseded
                ? {
                    label: `${artifacts.selected.label} v${artifacts.activeNode.version} · superseded by v${artifacts.selected.versions.at(-1)?.version}`,
                    run: () => void promote(),
                    busy: promoting,
                  }
                : null
            }
          />
        </>
      ) : null}

      {agentAddress && stage === 9 ? (
        <StagePanes strip={stripEl} conversation={conversation}>
          {reader ?? (
            <div className="stage-inner">
              <DeliveryPanel
                detail={detail}
                tenantId={tenantId}
                latestReply={latestSpecialistMessage}
                onAccept={acceptDelivery}
                onRejectSendBack={() => void sendBack(8)}
              />
            </div>
          )}
        </StagePanes>
      ) : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
function DesignPanel({
  detail,
  tenantId,
  onChanged,
  onApprove,
  onRevise,
  latestReply,
  canApprove,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** Persists the specialist's latest reply and advances to stage 5. */
  onApprove: () => Promise<unknown>;
  /** Sends free-form feedback text to the stage-4 specialist's mail thread. */
  onRevise: (prompt: string) => Promise<unknown>;
  /** The specialist's latest unpersisted reply — the mockup, before approval. */
  latestReply: ChatMessage | null;
  /** The project workflow's own verdict — the only gate on the Approve button. */
  canApprove: boolean;
}) {
  // The design history is just this project's `design_artifact` nodes —
  // already on `detail`, so no route of its own is needed to read it. Under
  // the mail-chat contract nothing writes one of these until approval, so
  // the specialist's latest reply stands in as a not-yet-persisted design
  // while none exists yet.
  const persisted = useMemo(
    () => detail.nodes.filter((node) => node.kind === "design_artifact").sort((left, right) => left.version - right.version),
    [detail.nodes],
  );
  const draftNode: ArtifactNode | null = latestReply
    ? {
        id: `reply:${latestReply.id}`,
        kind: "design_artifact",
        variant: null,
        stage: 4,
        title: stageName(4),
        version: (persisted.at(-1)?.version ?? 0) + 1,
        artifactId: `reply:${latestReply.id}`,
        contentHash: "",
        sizeBytes: latestReply.body.length,
        mediaType: "text/html",
        createdAt: latestReply.at,
        supersededByNodeId: null,
        provenance: { producer: "specialist" },
      }
    : null;
  const designs = persisted.length > 0 ? persisted : draftNode ? [draftNode] : [];
  const [contentByNode, setContentByNode] = useState(new Map<string, string>());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const contents = await Promise.all(
      persisted.map(async (design) => {
        // An unreadable version is not an empty one. Saying so on the version
        // itself keeps the rest of the history usable.
        const artifact = await api.artifactContent(tenantId, design.id).catch(() => null);
        return [design.id, artifact?.content ?? UNREADABLE] as const;
      }),
    );
    setContentByNode(new Map(draftNode ? [...contents, [draftNode.id, latestReply?.body ?? ""] as const] : contents));
  }, [persisted, tenantId, draftNode?.id, latestReply?.body]);

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setLoadError(`The design history could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }, [load]);

  return (
    // The stage fills the window and clips, so this is the region that
    // scrolls: a mockup, its comments and the feedback form together run
    // well past one screen.
    <div className="design-review">
      {loadError ? (
        <Banner tone="error" title="The design history could not be read">
          {loadError}
        </Banner>
      ) : null}
      <DesignFeedbackView
        designs={designs}
        feedbackByNode={new Map<string, FoldedFeedback>()}
        contentByNode={contentByNode}
        tenantId={tenantId}
        approval={{
          soloApproval: detail.soloApproval,
          canApprove,
          onApprove: () => onApprove(),
        }}
        revise={(_feedback, prompt) => onRevise(prompt)}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

/**
 * The senior engineer panel's four independent reviews.
 *
 * Shown side by side and never merged. Section 8 makes the four principals
 * independent, and a UI that concatenates them into one scrolling document
 * undoes that at the last step — the reader has to be able to see that
 * security and platform reached their verdicts separately.
 */
/**
 * Stage 6's requirements, beside the plan: what stages 1 to 4 agreed,
 * gathered into the document the plan is written against. Folded to one line
 * by default, since the plan is what the person is here to read.
 */
export function ProductRequirements({
  node,
  tenantId,
  canRewrite,
  busy,
  onRewrite,
}: {
  node: ArtifactNode;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  canRewrite: boolean;
  busy: boolean;
  onRewrite: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    void api
      .artifactContent(tenantId, node.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, tenantId]);
  return (
    <Screen
      title="Product requirements"
      description="What stages 1 to 4 agreed, gathered into the one document the plan is written against. The plan cites its ids."
      status={<StateLabel tone="info">Version {node.version}</StateLabel>}
      tight
    >
      <details className="document-fold">
        <summary className="document-fold-summary">
          <span className="document-fold-title">Requirements</span>
          <span className="document-fold-digest">{versionDigest(node)}</span>
        </summary>
        <div className="document-body document-fold-body">
          {content === null ? <p className="inline-note">Loading…</p> : <Markdown source={content} />}
        </div>
      </details>
      {canRewrite ? (
        <div className="button-row">
          <Button loading={busy} onClick={onRewrite}>
            Write the requirements again
          </Button>
        </div>
      ) : null}
    </Screen>
  );
}

export function PanelReviews({ reviews, tenantId }: { reviews: ArtifactNode[]; tenantId: string }) {
  const live = reviews.filter((node) => node.supersededByNodeId === null);
  const [openId, setOpenId] = useState<string | null>(live[0]?.id ?? null);
  const [contents, setContents] = useState(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      live.map(async (node) => {
        const result = await api.artifactContent(tenantId, node.id).catch(() => null);
        return [node.id, result?.content ?? UNREADABLE] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setContents(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [live.map((node) => node.id).join(","), tenantId]);

  const open = live.find((node) => node.id === openId) ?? live[0] ?? null;
  const body = open ? (contents.get(open.id) ?? "") : "";
  const verdictOf = (text: string) => {
    const match = /##\s*Verdict\s*\n+([^\n#]+)/i.exec(text);
    return match?.[1]?.trim() ?? null;
  };
  // Folded, the line carries every principal's verdict, so the four can be
  // compared without opening any of them.
  const verdicts = live
    .map((node) => `${node.variant ?? node.title}: ${verdictOf(contents.get(node.id) ?? "") ?? "…"}`)
    .join(" · ");

  return (
    <Screen
      title="Independent engineering review"
      description="Four principals reviewed this plan separately. Their findings are not merged."
      tight
    >
      <details className="document-fold">
        <summary className="document-fold-summary">
          <span className="document-fold-title">Reviews</span>
          <span className="document-fold-digest">{verdicts}</span>
        </summary>
        <div className="document-fold-body">
          <Tabs
            label="Panel principals"
            active={open?.id ?? ""}
            onChange={setOpenId}
            tabs={live.map((node) => ({
              id: node.id,
              label: node.variant ?? node.title,
            }))}
          >
            {/* The review reads inside the panel the tab controls, so switching
                principals announces the finding rather than an empty region. */}
            {() => (
              <>
                <p className="inline-note">
                  {open ? (verdictOf(contents.get(open.id) ?? "") ?? "No verdict stated.") : null}
                </p>
                <div className="document-body">
                  {body ? <Markdown source={body} /> : <p className="inline-note">Loading…</p>}
                </div>
              </>
            )}
          </Tabs>
        </div>
      </details>
    </Screen>
  );
}
