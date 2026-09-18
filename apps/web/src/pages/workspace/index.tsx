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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiFailure,
  type ArtifactNode,
  type BuildEvent,
  type DesignFeedback,
  type Evaluation,
  type ProjectDetail,
  type Quote,
  type StageTurn,
} from "../../client.js";
import { Textarea, Tabs } from "@corbits/react-ui";
import { Markdown } from "../../markdown.jsx";
import { AudiencePackages } from "../audiences.jsx";
import { DesignFeedbackView } from "../design.jsx";
import { AddMaterial, Banner, Button, Screen, StateLabel, stageName, versionDigest } from "../../components.jsx";
import { Dictated } from "../../dictation.jsx";
import { StageGate, STAGE_GOAL } from "./gate.jsx";
import { Preparing } from "./preparing.jsx";
import { clock } from "./elapsed.jsx";
import { StageDocument } from "./document.jsx";
import { SELECTABLE_TARGETS } from "@solutions-builder/app/targets";
import { EVALUATED_STAGE } from "@solutions-builder/app/workflows/stage-loop";
import type { StageStatus } from "../../run-fold.ts";
import { approvalCommand, deliverDraft, deliverGate, deliverRound, DRAFT_MAX_TOKENS_DEFAULT, submitThen } from "../../run-signal.ts";
import { foldEvaluation, foldStageThread, nextOpenQuestion } from "../../stage-thread.ts";
import type { Stage } from "@solutions-builder/app/ledger";

export { StageDocument, DocumentBody } from "./document.jsx";
export { ApprovalsRecord, STAGE_GOAL } from "./gate.jsx";

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

export function StageWorkspace({
  detail,
  standing = null,
  draftOpen = true,
  onChanged,
  onOpenSettings,
  onOpenDecisions,
}: {
  detail: ProjectDetail;
  /** Where the run stands, folded from `/hub` events — not from GET `/projects/:id`. */
  standing?: StageStatus | null;
  draftOpen?: boolean;
  onChanged: () => void;
  onOpenSettings: () => void;
  onOpenDecisions?: () => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<
    import("../../client.js").Remediation | undefined
  >(undefined);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [turns, setTurns] = useState<StageTurn[]>([]);
  const [openQuestion, setOpenQuestion] = useState<{ remaining: number; ordinal: number } | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);

  const current = detail.current;
  const stage = current?.stage ?? 1;
  const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
  // The panel's reviews live at stage 6 alongside the plan, but they are not
  // versions of it: mixing them into one version selector reads as five drafts
  // of the same document when it is one document and four opinions of it.
  // The requirements are the document the plan is written against, kept
  // beside it for the same reason. Design feedback is recorded as a stage-4
  // node too, and is a record of what was said about a version, not a
  // version: the newest node after feedback is the feedback, and a gate that
  // named it would approve the wrong thing.
  const stageNodes = detail.nodes.filter(
    (node) =>
      node.stage === stage &&
      node.kind !== "engineering_review" &&
      node.kind !== "product_requirements" &&
      node.kind !== "design_feedback" &&
      node.kind !== "source_material" &&
      // The slides built from a stage 5 package are a file beside it, not a
      // version of the stage's document, and never what a gate approves.
      node.kind !== "audience_deck",
  );
  const panelReviews = detail.nodes.filter(
    (node) => node.stage === stage && node.kind === "engineering_review",
  );
  const requirements =
    detail.nodes.find((node) => node.stage === stage && node.kind === "product_requirements" && node.supersededByNodeId === null) ??
    null;
  // What the gate names at this stage: the document, and at stage 6 the
  // requirements it was written against, so the approval covers both.
  const approvedVersions = (node: ArtifactNode) =>
    [node, ...(stage === 6 && requirements ? [requirements] : [])].map((entry) => ({
      artifactId: entry.artifactId,
      versionId: entry.id,
      contentHash: entry.contentHash,
    }));
  const latest = stageNodes.find((node) => node.supersededByNodeId === null) ?? stageNodes.at(-1) ?? null;
  const active = stageNodes.find((node) => node.id === selectedNode) ?? latest;

  // The document follows the conversation: each answer writes a new version,
  // and a reader who has not gone back to an older one sees it land. Someone
  // who did go back is reading on purpose, so they are told rather than moved.
  useEffect(() => {
    if (selectedNode && latest && selectedNode !== latest.id) {
      const pinned = stageNodes.find((node) => node.id === selectedNode);
      if (pinned?.supersededByNodeId === latest.id) setSelectedNode(null);
    }
  }, [latest?.id]);
  const newer = latest && active && active.id !== latest.id ? latest : null;

  useEffect(() => {
    if (!active) {
      setContent("");
      return;
    }
    let cancelled = false;
    void api
      .artifact(active.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id]);

  /**
   * Reads the stage's conversation.
   *
   * Called on arrival and again by whatever just changed it. Inferring "a
   * message was sent" from some other number moving is how one went missing:
   * a reply adds a turn and no document, and it does not move the project's
   * revision either, so nothing the screen was watching changed and the
   * message a person had just written was never drawn.
   */
  const loadThread = useCallback(async () => {
    try {
      const carried = detail.carriedTurns.filter((entry) => entry.stage === stage).map((entry) => entry.turn);
      const [threadTurns, evaluationResult] = await Promise.all([
        foldStageThread({
          tenantId: detail.tenantId,
          anchorRunId: detail.anchorRunId,
          stage: stage as Stage,
          nodes: detail.nodes,
          opening: stage === 1 ? detail.opening : null,
          carried,
        }),
        stage === EVALUATED_STAGE
          ? foldEvaluation({ tenantId: detail.tenantId, anchorRunId: detail.anchorRunId, stage: stage as Stage })
          : Promise.resolve(null),
      ]);
      setTurns(threadTurns);
      setOpenQuestion(nextOpenQuestion(threadTurns));
      setEvaluation(evaluationResult);
    } catch (cause) {
      // An empty thread and a thread that could not be read look identical on
      // screen — and that screen then asks for what the person already said.
      setTurns([]);
      setEvaluation(null);
      setError(
        `The conversation for this stage could not be read: ${
          cause instanceof ApiFailure ? cause.detail.message : String(cause)
        }`,
      );
    }
  }, [detail.project.id, stage]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  // Something a draft wants the person to hear about how it came to be — a
  // retry the designer's limit policy asked for. Said once, here, since the
  // thread is projected from the run and a retry is not a turn in it.
  const [notice, setNotice] = useState<string | null>(null);
  // Material handed over mid-project: dropped anywhere on the stage view. It
  // is read on the next draft, and the notice says so rather than redrafting
  // on the person's behalf.
  const [dragging, setDragging] = useState(false);
  // Dropped anywhere on the stage, or chosen through the picker beside the
  // composer and on the opening screen: one path either way.
  const attach = (files: FileList | File[]) => {
    const list = [...files];
    if (list.length === 0) return Promise.resolve();
    return run("material", async () => {
      const { attached } = await api.attachMaterial(detail.project.id, list);
      const names = attached.map((entry) => entry.name).join(", ");
      return { note: `Attached ${names}. The specialists read it with their next draft: say what to do with it, or ask for a redraft.` };
    });
  };
  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setRemediation(undefined);
    try {
      const result = await work();
      if (result && typeof result === "object" && "note" in result && typeof result.note === "string") {
        setNotice(result.note);
      }
      // A stage 5 round that wrote some packages and not others is not a
      // failure of the round: the written ones are recorded, and the
      // packages screen offers to write the missing ones again.
      if (result && typeof result === "object" && "failed" in result && Array.isArray(result.failed) && result.failed.length > 0) {
        const failed = result.failed as { audience: string; message: string }[];
        setError(failed.map((entry) => `The package for ${entry.audience} could not be written. ${entry.message}`).join(" "));
      }
      await loadThread();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setRemediation(cause instanceof ApiFailure ? cause.detail.remediation : undefined);
    } finally {
      setBusy(null);
    }
  };

  const awaitingReview = current?.state === "waiting_approval";
  const inProgress = current?.state === "in_progress";
  const backtracked = current?.state === "backtracked";

  // What the person has already said on this stage, before any draft exists.
  const said = turns.filter((turn) => turn.role === "human");

  // The specialist starts as soon as it has something to work from. Asking
  // "anything to add?" before it has said a word is the app asking the person
  // to do its job: the whole premise is that it interviews them, and somebody
  // who has just typed one line has nothing more to volunteer yet.
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!inProgress || stage > 7) return;
    if (stageNodes.length > 0) return;
    // Stage 1 has nothing to read until the problem is described. Every later
    // stage has the approved work, so it starts on its own.
    if (stage === 1 && said.length === 0) return;
    const key = `${detail.project.id}:${stage}`;
    if (startedRef.current === key) return;
    startedRef.current = key;
    void run("draft", () =>
      deliverDraft(detail, stage as Stage, {
        command: "stage.draft",
        runId: current!.id,
        message: "",
        mode: "final",
        draft: true,
        inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
      }),
    );
  }, [detail.project.id, stage, inProgress, stageNodes.length, said.length]);

  // One view at a time, and a new one settles in rather than snapping: the
  // stage advancing is the biggest moment in the app and a hard cut reads as
  // a glitch. Keyed so React mounts fresh when the stage or its phase changes.
  const phase = stageNodes.length === 0 ? "preparing" : awaitingReview ? "waiting" : "drafting";
  return (
    <div
      key={`${stage}:${phase}`}
      className={dragging ? "stage-view is-dragging" : "stage-view"}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void attach(event.dataTransfer.files);
      }}
    >
      {awaitingReview && stage <= 7 && active ? (
        <StageGate
          soloApproval={detail.soloApproval}
          busy={busy === "submit"}
          evaluation={evaluation}
          quorum={
            stage === 5
              ? (() => {
                  const policy = (detail.project.policy ?? {}) as { audienceQuorum?: number; audiences?: unknown[] };
                  const decisions = detail.approvals.filter(
                    (approval) => approval.command === "audience.decide" && approval.runId === current?.id,
                  );
                  return {
                    named: policy.audiences?.length ?? 0,
                    needed: policy.audienceQuorum ?? 0,
                    proceeded: decisions.filter((approval) => approval.decision === "proceed").length,
                    blocked: decisions.filter((approval) => approval.decision !== "proceed").length,
                  };
                })()
              : null
          }
          onApprove={() =>
            run("submit", () =>
              deliverGate(detail, stage as Stage, standing, {
                command: approvalCommand(stage as Stage),
                runId: current!.id,
                versions: approvedVersions(active),
              }),
            )
          }
          onOpenDecisions={onOpenDecisions}
        />
      ) : null}

      {/* Stage 5 shows its own stakeholder rows, each with a way to write
          the package, so its preparing view is only for the round under way. */}
      {stageNodes.length === 0 && inProgress && stage <= 7 && (stage !== 5 || busy === "draft") ? (
        stage === 1 && said.length === 0 ? (
          <Screen title={`Stage 1 of 9 · ${stageName(1)}`} description={STAGE_GOAL[1]} tight>
            <div className="screen-body">
              <div className="field">
                <label htmlFor="stage-input">What is the problem?</label>
                <Dictated value={input} onValueChange={setInput} disabled={busy === "draft"} align="start">
                  <Textarea
                    id="stage-input"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="Describe it in your own words. Rough is fine."
                  />
                </Dictated>
              </div>
              <p className="inline-note material-cue">
                Have documents or images? Drop them anywhere here, or <AddMaterial className="material-add-inline" onAdd={attach} />{" "}
                They are read with every draft.
              </p>
              <Button
                variant="primary"
                loading={busy === "draft"}
                onClick={() =>
                  run("draft", async () => {
                    await deliverDraft(detail, stage as Stage, {
                      command: "stage.draft",
                      runId: current!.id,
                      message: input,
                      mode: "final",
                      draft: true,
                      inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
                    });
                    setInput("");
                  })
                }
              >
                Draft this stage
              </Button>
            </div>
          </Screen>
        ) : (
          <>
            <Preparing
              stage={stage}
              said={said}
              busy={busy === "draft"}
              since={standing?.since ?? null}
            />
            <p className="inline-note material-cue">
              Documents or images to hand over meanwhile? Drop them anywhere here, or{" "}
              <AddMaterial className="material-add-inline" onAdd={attach} />{" "}
              They are read with the next draft.
            </p>
          </>
        )
      ) : null}

      {notice ? (
        <Banner tone="warning" title={notice} action={{ label: "Dismiss", onClick: () => setNotice(null) }} />
      ) : null}

      {error ? (
        <Banner
          tone="error"
          title={error}
          {...(remediation
            ? {
                action: {
                  label: remediation.label,
                  // Connecting a provider, reconnecting one and choosing another
                  // model all happen in Settings. Retry is the exception and is
                  // handled here.
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

      {backtracked ? (
        <Screen
          title={`Routed back to stage ${current?.stage}`}
          description="The earlier decision and its artifacts are retained, superseded rather than deleted."
        >
          <Button variant="primary" disabled>
            Resume at stage {current?.stage}
          </Button>
          <p className="inline-note">
            Resuming this stage automatically is blocked on CL-8461 (the workflow cannot yet re-enter a
            stage's loop after moving past it).
          </p>
        </Screen>
      ) : null}

      {stage === 4 ? <DesignPanel detail={detail} standing={standing} onChanged={onChanged} /> : null}

      {/* The stage fills the window and clips, so a stage that is a stack of
          screens rather than the document layout needs a region of its own
          to scroll, as the design review has. Without one, whatever sits
          below the fold — the decisions table, the rationale — cannot be
          reached at all. */}
      {stage === 5 ? (
        <div className="stage-scroll">
          <AudiencePackages
            detail={detail}
            onChanged={onChanged}
            drafting={busy === "draft"}
            onDraftPackages={(audiences) =>
              run("draft", async () => {
                await deliverDraft(detail, stage as Stage, {
                  command: "stage.draft",
                  runId: current!.id,
                  message: "",
                  mode: "final",
                  draft: true,
                  inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
                  audiences,
                });
                // Said once the round is delivered: the rewrite itself lands
                // through the workflow's own persist, and the pane refetches.
                return { note: `Asked for ${audiences.join(", ")} again. The packages update here when the new versions land.` };
              })
            }
          />
        </div>
      ) : null}

      {stage === 8 ? (
        <div className="stage-scroll">
          <BuildPanel detail={detail} onChanged={onChanged} onOpenSettings={onOpenSettings} />
          {live.length > 0 ? <PacketSummary detail={detail} onChanged={onChanged} /> : null}
        </div>
      ) : null}

      {/* The documents that sit beside the plan at stage 6. The stage fills
          the window and clips, and the plan below keeps its own scrolling
          panes, so these live in a bounded region that scrolls on its own:
          folded, they are two lines; opened, they never push the plan out
          of reach. */}
      {requirements || panelReviews.length > 0 ? (
        <div className="stage-companions">
      {requirements ? (
        <ProductRequirements
          node={requirements}
          canRewrite={inProgress}
          busy={busy === "draft"}
          onRewrite={() =>
            run("draft", async () => {
              // The plan is written against the requirements, so a rewrite
              // of the requirements writes the plan again too. The rewrite
              // itself lands through the workflow's own persist, and the pane
              // refetches.
              await deliverDraft(detail, stage as Stage, {
                command: "stage.draft",
                runId: current!.id,
                message: "",
                mode: "final",
                draft: true,
                inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
                documents: ["requirements", "plan"],
              });
              return { note: "Rewriting the requirements, and the plan against them. They update here when the new versions land." };
            })
          }
        />
      ) : null}

      {panelReviews.length > 0 ? <PanelReviews reviews={panelReviews} /> : null}
        </div>
      ) : null}

      {active && stage <= 7 && stage !== 4 && stage !== 5 ? (
        <StageDocument
          node={active}
          newer={newer}
          draftOpen={draftOpen}
          versions={stageNodes}
          content={content}
          onSelectVersion={setSelectedNode}
          onAddMaterial={inProgress ? attach : undefined}
          busy={busy}
          canSubmit={inProgress}
          turns={turns}
          openQuestion={openQuestion}
          evaluation={evaluation}
          onRevise={(message: string, quotes: Quote[], revise?: boolean) => {
            // Shown before the round trip. A message that leaves the box and
            // appears nowhere reads as lost, and the person writes it again.
            // `loadThread` replaces this with the recorded turn.
            if (message.trim().length > 0 || quotes.length > 0) {
              setTurns((current) => [
                ...current,
                {
                  id: `pending-${current.length}`,
                  role: "human",
                  body: message,
                  quotes,
                  resultNodeId: null,
                  questions: null,
                  createdAt: new Date().toISOString(),
                },
              ]);
            }
            // Interview-vs-final is the client's call: the thread's own
            // open-question state already says whether one is outstanding.
            const mode: "interview" | "final" =
              !revise && openQuestion !== null && message.trim().length > 0 && openQuestion.remaining > 0
                ? "interview"
                : "final";
            void run("draft", () =>
              deliverDraft(detail, stage as Stage, {
                command: "stage.draft",
                runId: current!.id,
                message,
                ...(quotes.length > 0 ? { quotes } : {}),
                mode,
                draft: true,
                inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
              }),
            );
          }}
          soloApproval={detail.soloApproval}
          onSubmit={() =>
            run("submit", () => {
              const submit = { runId: current!.id, versions: approvedVersions(active) };
              // One decision when nobody else can take it: submitting a thing
              // to yourself and then approving it is two clicks for one act.
              return detail.soloApproval
                ? submitThen(detail, stage as Stage, standing, submit, { command: approvalCommand(stage as Stage), ...submit })
                : deliverGate(detail, stage as Stage, standing, { command: "stage.submit", ...submit });
            })
          }
        />
      ) : null}


      {live.length > 0 && stage >= 7 && stage !== 8 ? <PacketSummary detail={detail} onChanged={onChanged} /> : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
function DesignPanel({ detail, standing, onChanged }: { detail: ProjectDetail; standing: StageStatus | null; onChanged: () => void }) {
  const [designs, setDesigns] = useState<ArtifactNode[]>([]);
  const [feedbackByNode, setFeedbackByNode] = useState(
    new Map<string, { feedback?: DesignFeedback; prompt?: string }>(),
  );
  const [contentByNode, setContentByNode] = useState(new Map<string, string>());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // A design history that fails to load renders as "no design yet", which is
    // a different and much more alarming statement than "I could not read it".
    const result = await api.design(detail.project.id).catch((cause: unknown) => {
      setLoadError(
        `The design history could not be read: ${
          cause instanceof ApiFailure ? cause.detail.message : String(cause)
        }`,
      );
      return null;
    });
    if (!result) return;
    setDesigns(result.designs);
    setFeedbackByNode(
      new Map(
        result.feedback.map((entry) => [
          entry.designNodeId,
          { ...(entry.feedback ? { feedback: entry.feedback } : {}), ...(entry.prompt ? { prompt: entry.prompt } : {}) },
        ]),
      ),
    );
    const contents = await Promise.all(
      result.designs.map(async (design) => {
        // An unreadable version is not an empty one. Saying so on the version
        // itself keeps the rest of the history usable.
        const artifact = await api.artifact(design.id).catch(() => null);
        return [design.id, artifact?.content ?? UNREADABLE] as const;
      }),
    );
    setContentByNode(new Map(contents));
  }, [detail.project.id, detail.nodes.length]);

  useEffect(() => {
    void load();
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
        projectId={detail.project.id}
        designs={designs}
        feedbackByNode={feedbackByNode}
        contentByNode={contentByNode}
        approval={{
          soloApproval: detail.soloApproval,
          canApprove: detail.current?.state === "in_progress",
          // One decision when nobody else can take it, as on the written
          // stages: submitting a thing to yourself and then approving it is
          // two clicks for one act.
          onApprove: (design) => {
            const submit = {
              runId: detail.current!.id,
              versions: [{ artifactId: design.artifactId, versionId: design.id, contentHash: design.contentHash }],
            };
            return detail.soloApproval
              ? submitThen(detail, 4, standing, submit, { command: "stage.approve", ...submit })
              : deliverGate(detail, 4, standing, { command: "stage.submit", ...submit });
          },
        }}
        revise={(prompt) =>
          deliverDraft(detail, 4, {
            command: "stage.draft",
            runId: detail.current!.id,
            message: prompt,
            mode: "final",
            draft: true,
            inference: { maxTokens: DRAFT_MAX_TOKENS_DEFAULT },
          })
        }
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

/** Stage 7 → 8: cost approval, then the freeze interlock. */
function PacketSummary({
  detail,
  onChanged,
}: {
  detail: ProjectDetail;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const current = detail.current;
  const costNode = detail.nodes.find(
    (node) => node.kind === "cost_approval" && node.supersededByNodeId === null,
  );
  const readyToFreeze = current?.state === "cost_approved";

  if (!current || current.stage !== 7) return null;

  return (
    <Screen
      title="Freezing the packet"
      description="Requires cost approval on the same run, and happens once."
      status={
        readyToFreeze ? (
          <StateLabel tone="warning">Cost approved — not yet frozen</StateLabel>
        ) : (
          <StateLabel tone="disabled">Awaiting cost approval</StateLabel>
        )
      }
    >
      {error ? <Banner tone="error" title="Freeze refused">{error}</Banner> : null}
      <div className="grid gap-2">
        <p className="text-sm font-medium">How will this be used?</p>
        <p className="text-xs text-muted-foreground">
          Choose every way someone will need to use the finished build. Only a command-line
          check is actually run today — the others are honest about not being verified yet.
        </p>
        <div className="grid gap-2">
          {SELECTABLE_TARGETS.map((option) => (
            <label key={option.target} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={chosen.has(option.target)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(option.target);
                  else next.delete(option.target);
                  setChosen(next);
                }}
              />
              <span>
                <span className="text-sm">{option.label}</span>{" "}
                {option.verified ? (
                  <StateLabel tone="okay">verified today</StateLabel>
                ) : (
                  <StateLabel tone="disabled">not verified yet</StateLabel>
                )}
              </span>
            </label>
          ))}
        </div>
      </div>
      <Button
        variant="primary"
        disabled={!readyToFreeze || !costNode || chosen.size === 0}
        loading={busy}
        onClick={async () => {
          if (!costNode) return;
          setBusy(true);
          setError(null);
          try {
            // The freeze admission between stage 7's gate and stage 8's
            // round: the cost-approved version travels in the intent, since
            // this gate has no other way to read it.
            await deliverRound(detail, 7, {
              command: "build.freeze",
              runId: current.id,
              versions: detail.nodes
                .filter((node) => node.supersededByNodeId === null)
                .map((node) => ({
                  artifactId: node.artifactId,
                  versionId: node.id,
                  contentHash: node.contentHash,
                })),
              placement: "local",
              targets: [...chosen],
              costApprovalVersionId: costNode.id,
            });
            onChanged();
          } catch (cause) {
            setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        Freeze the build packet
      </Button>
    </Screen>
  );
}

/**
 * Stage 8: build supervision, capability-honest about the bounded bridge.
 *
 * The bridge reports final text and an exit status, and whether it could run
 * at all. Each of those is shown as what it is: a worker that is unavailable
 * is a state with a reason and a way to the screen that explains it, never an
 * exit status of "null". The controls are the ledger's — start, cancel while
 * the worker is up, try again once the run is terminal — and nothing that the
 * bridge cannot actually do.
 */
function BuildPanel({
  detail,
  onChanged,
  onOpenSettings,
}: {
  detail: ProjectDetail;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState<"start" | "cancel" | "fail" | "retry" | "continue" | "accept" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const current = detail.current;
  const state = current?.state ?? null;
  const running = state === "running";
  const terminal = state === "failed" || state === "cancelled" || state === "interrupted";

  const loadEvents = useCallback(
    () =>
      api
        .buildEvents(detail.project.id)
        .then((result) => result.events)
        .catch(() => [] as BuildEvent[]),
    [detail.project.id],
  );

  useEffect(() => {
    let cancelled = false;
    void loadEvents().then((next) => {
      if (!cancelled) setEvents(next);
    });
    return () => {
      cancelled = true;
    };
  }, [loadEvents, detail.runs.length, current?.id, state]);

  // The worker ends on its own time. While the run is up, its final event and
  // the state the host settled it to are fetched until one of them lands.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void loadEvents().then((next) => {
        setEvents(next);
        if (next.some((event) => event.runId === current?.id && event.type === "bridge.final")) onChanged();
      });
    }, 5_000);
    return () => clearInterval(timer);
  }, [running, loadEvents, onChanged, current?.id]);

  // What the worker has written so far, from the host's stream: begun when
  // the host says when it started, `idle` when this host is not running the
  // attempt at all. Closed when the run is no longer running.
  const [live, setLive] = useState<{ startedAt: string; text: string } | "idle" | null>(null);
  useEffect(() => {
    if (!running || !current) {
      setLive(null);
      return;
    }
    const source = new EventSource(`/api/projects/${detail.project.id}/build/live?runId=${encodeURIComponent(current.id)}`);
    source.addEventListener("idle", () => {
      setLive("idle");
      source.close();
    });
    source.addEventListener("begin", (event) => {
      const { startedAt } = JSON.parse((event as MessageEvent<string>).data) as { startedAt: string };
      setLive({ startedAt, text: "" });
    });
    source.addEventListener("text", (event) => {
      const text = JSON.parse((event as MessageEvent<string>).data) as string;
      setLive((before) => (before && before !== "idle" ? { ...before, text: (before.text + text).slice(-200_000) } : before));
    });
    source.addEventListener("done", () => {
      source.close();
      void loadEvents().then(setEvents);
      onChanged();
    });
    return () => source.close();
  }, [running, current?.id, detail.project.id, onChanged, loadEvents]);

  const final = events.find((event) => event.runId === current?.id && event.type === "bridge.final");

  // A run canceled from here turns terminal before its worker has ended, so
  // the stream above is closed before "done" and the final event is not yet
  // on the ledger. It is fetched again, briefly, until it is.
  useEffect(() => {
    if (!terminal || final) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > 60) {
        clearInterval(timer);
        return;
      }
      void loadEvents().then(setEvents);
    }, 1_000);
    return () => clearInterval(timer);
  }, [terminal, final, loadEvents]);
  const unavailable = final?.payload.available === false;
  const exitStatus = final ? (final.payload.exitStatus as number | null) : null;
  const stderrTail = final ? String(final.payload.stderrTail ?? "").trim() : "";
  const produced = final?.payload.produced as { changed: boolean; summary: string } | null | undefined;
  // A worker that ran and left nothing behind is not a success, whatever its
  // exit status: an exit of 0 here is "the process returned cleanly", not
  // "the build did something".
  const wroteNothing = !unavailable && produced !== null && produced !== undefined && produced.changed === false;
  // The worker ran and has ended, and the ledger still says running: the
  // attempt is not over until the person says what its result was.
  const ended = running && final !== undefined && !unavailable;

  const act = async (name: "start" | "cancel" | "fail" | "retry" | "continue" | "accept", work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const start = (runId: string) =>
    deliverRound(detail, 8, { command: "build.start_attempt", runId });
  // A worker ran here, so there is work to continue from; a worker that could
  // not run left nothing.
  const hasWork = final !== undefined && !unavailable;
  const archiveName = `${
    detail.project.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "project"
  }.tar.gz`;
  /**
   * The ledger's way to another attempt: an ended attempt is failed first,
   * then a new one is queued from the terminal run and started — in the
   * previous attempt's workspace when the person chooses to continue.
   */
  const tryAgain = (continuing: boolean) =>
    act(continuing ? "continue" : "retry", async () => {
      if (!current) return;
      const from = current.id;
      if (ended) {
        // A signal on the run's evidence park; the workflow settles the attempt.
        await deliverGate(detail, 8, null, {
          command: "build.fail",
          runId: current.id,
          reason: "Failed to try the build again from the build supervision screen.",
        });
      }
      // Two rounds, same as the ledger's two rows: `build.start_attempt` from
      // the terminal run queues a fresh attempt (the guard's own carried
      // state moves queued), then the same command again starts it running.
      await deliverRound(detail, 8, {
        command: "build.start_attempt",
        runId: from,
        ...(continuing ? { continueFromRunId: current.id } : {}),
      });
      await deliverRound(detail, 8, { command: "build.start_attempt", runId: from });
    });
  const tryAgainButtons = hasWork ? (
    <>
      <Button variant={ended ? "outline" : "primary"} loading={busy === "continue"} onClick={() => void tryAgain(true)}>
        Try again, continuing from this attempt's work
      </Button>
      <Button variant="outline" loading={busy === "retry"} onClick={() => void tryAgain(false)}>
        Try again from scratch
      </Button>
    </>
  ) : (
    <Button variant="primary" loading={busy === "retry"} onClick={() => void tryAgain(false)}>
      Try the build again
    </Button>
  );

  return (
    <div data-tour="build-panel">
    <Screen
      title="Build supervision"
      status={
        current ? (
          <StateLabel tone={ended ? "warning" : running ? "loading" : terminal ? "error" : "selected"}>
            {ended ? "worker ended · your decision" : current.state.replace(/_/g, " ")}
          </StateLabel>
        ) : null
      }
    >
      {error ? <Banner tone="error" title="The build attempt could not be changed">{error}</Banner> : null}

      {unavailable ? (
        <Banner
          tone="error"
          title="The build worker is unavailable"
          action={{ label: "Open Settings", onClick: onOpenSettings }}
        >
          {stderrTail || "The worker this host looks for could not be run."} Settings › Diagnostics names the worker
          and what it reported.
        </Banner>
      ) : null}

      {wroteNothing ? (
        <Banner tone="error" title="The worker exited cleanly but wrote nothing">
          {produced?.summary || "The workspace is unchanged since the attempt began."} An exit status of 0 is not a
          verdict on the work.
        </Banner>
      ) : null}

      {terminal && !unavailable && current?.terminalReason ? (
        <p className="inline-note">
          {current.state === "failed" ? "Failed" : current.state === "cancelled" ? "Cancelled" : "Interrupted"}:{" "}
          {current.terminalReason}
        </p>
      ) : null}

      {ended ? (
        <p className="inline-note">
          The worker has ended
          {exitStatus === 0 ? " with exit status 0" : exitStatus === null ? " without an exit status" : ` with exit status ${exitStatus}`}.
          An exit status is not a verdict on the work: read what it left below, then say what it was. Its work is
          packaged as <code>{archiveName}</code> and recorded as this project's build; accepting it opens delivery
          review, where that archive's bytes are verified.
        </p>
      ) : null}

      {current && (state === "queued" || running || terminal) ? (
        <div className="button-row">
          {state === "queued" ? (
            <Button
              variant="primary"
              loading={busy === "start"}
              onClick={() =>
                act("start", async () => {
                  await start(current.id);
                })
              }
            >
              Start the build attempt
            </Button>
          ) : null}
          {running && !ended ? (
            <Button
              variant="destructive"
              loading={busy === "cancel"}
              onClick={() =>
                act("cancel", async () => {
                  // A signal on the run; the worker follows the run and stops.
                  await deliverGate(detail, 8, null, {
                    command: "build.cancel",
                    runId: current.id,
                    reason: "Stopped from the build supervision screen.",
                  });
                })
              }
            >
              Cancel the build attempt
            </Button>
          ) : null}
          {ended ? (
            <>
              <Button
                variant="primary"
                loading={busy === "accept"}
                onClick={() =>
                  act("accept", async () => {
                    // The evidence park's own admit: the worker's reported
                    // verdict travels as the intent, same as any other gate.
                    await deliverGate(detail, 8, null, {
                      command: "build.accept_evidence",
                      runId: current.id,
                      ...(final ? (final.payload as Record<string, unknown>) : {}),
                    });
                  })
                }
              >
                Accept as evidence
              </Button>
              <Button
                variant="destructive"
                loading={busy === "fail"}
                onClick={() =>
                  act("fail", async () => {
                    // A signal on the run's evidence park; the workflow settles the attempt.
                    await deliverGate(detail, 8, null, {
                      command: "build.fail",
                      runId: current.id,
                      reason: `Marked failed from the build supervision screen after the worker ended${
                        exitStatus === null ? "" : ` with exit status ${exitStatus}`
                      }.`,
                    });
                  })
                }
              >
                Mark this attempt failed
              </Button>
              {tryAgainButtons}
            </>
          ) : null}
          {terminal ? tryAgainButtons : null}
        </div>
      ) : null}

      {final && !unavailable ? (
        <>
          <dl className="version-list">
            <div>
              <dt>Exit status</dt>
              <dd>
                {exitStatus === 0 && !wroteNothing ? (
                  <StateLabel tone="success">Exited 0</StateLabel>
                ) : exitStatus === 0 ? (
                  <StateLabel tone="error">Exited 0, wrote nothing</StateLabel>
                ) : exitStatus === null ? (
                  <StateLabel tone="error">Ended without an exit status</StateLabel>
                ) : (
                  <StateLabel tone="error">Exited {exitStatus}</StateLabel>
                )}
              </dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd className="hash">{String(final.payload.workspace ?? "")}</dd>
            </div>
            {produced ? (
              <div>
                <dt>Produced</dt>
                <dd>{produced.changed ? produced.summary : "nothing — the workspace is unchanged since the attempt began"}</dd>
              </div>
            ) : null}
            {final.payload.archive && typeof final.payload.archive === "object" ? (
              <div>
                <dt>Packaged</dt>
                <dd>
                  <BuildArchiveRow archive={final.payload.archive as { nodeId: string; name: string; root: string; sizeBytes: number }} />
                </dd>
              </div>
            ) : typeof final.payload.archiveError === "string" ? (
              <div>
                <dt>Packaged</dt>
                <dd>The work could not be packaged: {final.payload.archiveError}</dd>
              </div>
            ) : null}
            {typeof final.payload.continuedFrom === "string" ? (
              <div>
                <dt>Continued from</dt>
                <dd>
                  an earlier attempt's work, <span className="hash">{final.payload.continuedFrom}</span>
                </dd>
              </div>
            ) : null}
            {typeof final.payload.turns === "number" ? (
              <div>
                <dt>Reported</dt>
                <dd>
                  {final.payload.turns} turn{final.payload.turns === 1 ? "" : "s"} and {String(final.payload.toolCalls ?? 0)} tool
                  call{final.payload.toolCalls === 1 ? "" : "s"}, through the worker's own hook
                  {typeof final.payload.turnLog === "string" ? (
                    <>
                      : <span className="hash">{final.payload.turnLog}</span>
                    </>
                  ) : null}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="artifact">
            <pre>{String(final.payload.finalText ?? "") || "(no output)"}</pre>
          </div>
          {exitStatus !== 0 && stderrTail ? (
            <div className="artifact">
              <pre>{stderrTail}</pre>
            </div>
          ) : null}
        </>
      ) : running && !final ? (
        live === "idle" ? (
          <p className="inline-note">
            No worker is running for this attempt on this host. If the host was restarted while the worker was up, its
            work is not being watched: cancel this attempt and try the build again.
          </p>
        ) : (
          <LiveOutput startedAt={live?.startedAt ?? null} text={live?.text ?? ""} />
        )
      ) : !final ? (
        <p className="inline-note">No build attempt has reported yet.</p>
      ) : null}
    </Screen>
    </div>
  );
}

/** The build as packaged when the worker ended: its name, its size, where it unpacks, and a way to save it. */
function BuildArchiveRow({ archive }: { archive: { nodeId: string; name: string; root: string; sizeBytes: number } }) {
  const [state, setState] = useState<{ busy: boolean; saved: string | null; error: string | null }>({ busy: false, saved: null, error: null });
  const size = archive.sizeBytes >= 1024 * 1024 ? `${(archive.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(archive.sizeBytes / 1024))} KB`;
  return (
    <>
      <span className="hash">{archive.name}</span> · {size} · unpacks into <span className="hash">{archive.root}/</span> · in Artifacts as this
      project's build{" "}
      <Button
        variant="link"
        loading={state.busy}
        onClick={() => {
          setState({ busy: true, saved: null, error: null });
          api
            .saveArtifactFile(archive.nodeId)
            .then((result) => setState({ busy: false, saved: result.path, error: null }))
            .catch((cause) => setState({ busy: false, saved: null, error: cause instanceof ApiFailure ? cause.detail.message : String(cause) }));
        }}
      >
        Save it
      </Button>
      {state.saved ? <span className="inline-note"> Saved to {state.saved}</span> : null}
      {state.error ? <span className="inline-note"> {state.error}</span> : null}
    </>
  );
}

/**
 * A running worker, watched: how long it has been at it, and what it has
 * written so far, as it wrote it. The clock counts from when the host started
 * the worker, not from when this window opened, so a reload does not reset
 * it. The text is the process's own output, both pipes in arrival order,
 * following its own end unless the reader has scrolled up to read.
 */
function LiveOutput({ startedAt, text }: { startedAt: string | null; text: string }) {
  const [seconds, setSeconds] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (!startedAt) return;
    const started = Date.parse(startedAt);
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  useEffect(() => {
    const element = pane.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <>
      <p className="elapsed">
        <span className="elapsed-clock" role="timer" aria-live="off">
          {clock(seconds)}
        </span>{" "}
        {startedAt
          ? "elapsed. Below: the worker's output as it is written, and each turn it reports, with the tools it called."
          : "Waiting for the host to say when the worker started."}
      </p>
      <div
        className="artifact live-output"
        ref={pane}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        <pre>{text || "(nothing written yet)"}</pre>
      </div>
    </>
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
function ProductRequirements({
  node,
  canRewrite,
  busy,
  onRewrite,
}: {
  node: ArtifactNode;
  canRewrite: boolean;
  busy: boolean;
  onRewrite: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    void api
      .artifact(node.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id]);
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

function PanelReviews({ reviews }: { reviews: ArtifactNode[] }) {
  const live = reviews.filter((node) => node.supersededByNodeId === null);
  const [openId, setOpenId] = useState<string | null>(live[0]?.id ?? null);
  const [contents, setContents] = useState(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      live.map(async (node) => {
        const result = await api.artifact(node.id).catch(() => null);
        return [node.id, result?.content ?? UNREADABLE] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setContents(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [live.map((node) => node.id).join(",")]);

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

