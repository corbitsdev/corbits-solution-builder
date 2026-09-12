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
import { Banner, Button, Screen, StateLabel, stageName } from "../../components.jsx";
import { StageGate, STAGE_GOAL } from "./gate.jsx";
import { Preparing, STALL_AFTER_MS } from "./preparing.jsx";
import { StageDocument } from "./document.jsx";

export { StageDocument, DocumentBody } from "./document.jsx";
export { ApprovalsRecord, STAGE_GOAL } from "./gate.jsx";

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

export function StageWorkspace({
  detail,
  draftOpen = true,
  onChanged,
  onOpenSettings,
  onOpenDecisions,
}: {
  detail: ProjectDetail;
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
  // Design feedback is recorded as a stage-4 node too, and is a record of what
  // was said about a version, not a version: the newest node after feedback is
  // the feedback, and a gate that named it would approve the wrong thing.
  const stageNodes = detail.nodes.filter(
    (node) =>
      node.stage === stage &&
      node.kind !== "engineering_review" &&
      node.kind !== "design_feedback" &&
      node.kind !== "source_material" &&
      // The slides built from a stage 5 package are a file beside it, not a
      // version of the stage's document, and never what a gate approves.
      node.kind !== "audience_deck",
  );
  const panelReviews = detail.nodes.filter(
    (node) => node.stage === stage && node.kind === "engineering_review",
  );
  // The draft as the model writes it. Open while a draft is in flight, so the
  // document forms on screen instead of arriving whole a minute later.
  const [writing, setWriting] = useState<string | null>(null);
  // "begun" is the host saying the model has the prompt; until then the request
  // is still on its way. "stalled" is nothing back for a while after that.
  const [begun, setBegun] = useState(false);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (busy !== "draft") {
      setWriting(null);
      setBegun(false);
      setStalled(false);
      return;
    }
    const source = new EventSource(`/api/projects/${detail.project.id}/stages/${stage}/live`);
    const stall = setTimeout(() => setStalled(true), STALL_AFTER_MS);
    source.addEventListener("begin", () => setBegun(true));
    source.addEventListener("text", (event) => {
      clearTimeout(stall);
      setStalled(false);
      setBegun(true);
      setWriting(JSON.parse((event as MessageEvent<string>).data) as string);
    });
    return () => {
      source.close();
      clearTimeout(stall);
    };
  }, [busy, detail.project.id, stage]);
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
      const result = await api.thread(detail.project.id, stage);
      setTurns(result.turns);
      setOpenQuestion(result.open);
      setEvaluation(result.evaluation ?? null);
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
  const attach = (files: FileList) => {
    const list = [...files];
    if (list.length === 0) return;
    void run("material", async () => {
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
    void run("draft", () => api.draft(detail.project.id, stage, ""));
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
        attach(event.dataTransfer.files);
      }}
    >
      {awaitingReview && stage <= 7 && active ? (
        <StageGate
          soloApproval={detail.soloApproval}
          busy={busy === "submit"}
          evaluation={evaluation}
          onApprove={() =>
            run("submit", () =>
              api.decide(detail.project.id, {
                expectedRevision: detail.project.revision,
                runId: current!.id,
                versions: [
                  { artifactId: active.artifactId, versionId: active.id, contentHash: active.contentHash },
                ],
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
                <Textarea
                  id="stage-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Describe it in your own words. Rough is fine."
                />
              </div>
              <Button
                variant="primary"
                loading={busy === "draft"}
                onClick={() =>
                  run("draft", async () => {
                    await api.draft(detail.project.id, stage, input);
                    setInput("");
                  })
                }
              >
                Draft this stage
              </Button>
            </div>
          </Screen>
        ) : (
          <Preparing
            stage={stage}
            said={said}
            writing={writing}
            busy={busy === "draft"}
            begun={begun}
            stalled={stalled}
          />
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
          <Button
            variant="primary"
            loading={busy === "route"}
            onClick={() =>
              run("route", () =>
                api.command(detail.project.id, "stage.select_route", {
                  expectedRevision: detail.project.revision,
                  runId: current!.id,
                }),
              )
            }
          >
            Resume at stage {current?.stage}
          </Button>
        </Screen>
      ) : null}

      {stage === 4 ? <DesignPanel detail={detail} onChanged={onChanged} /> : null}

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
              run("draft", () => api.draft(detail.project.id, stage, "", [], audiences))
            }
          />
        </div>
      ) : null}

      {stage === 8 ? (
        <div className="stage-scroll">
          <BuildPanel detail={detail} onChanged={onChanged} />
          {live.length > 0 ? <PacketSummary detail={detail} onChanged={onChanged} /> : null}
        </div>
      ) : null}

      {panelReviews.length > 0 ? <PanelReviews reviews={panelReviews} /> : null}

      {active && stage <= 7 && stage !== 4 && stage !== 5 ? (
        <StageDocument
          node={active}
          live={writing}
          newer={newer}
          draftOpen={draftOpen}
          versions={stageNodes}
          content={content}
          onSelectVersion={setSelectedNode}
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
                  createdAt: new Date().toISOString(),
                },
              ]);
            }
            void run("draft", () =>
              api.reply(detail.project.id, stage, {
                message,
                quotes,
                ...(revise ? { revise: true } : {}),
              }),
            );
          }}
          soloApproval={detail.soloApproval}
          onSubmit={() =>
            run("submit", () =>
              // One decision when nobody else can take it: submitting a thing
              // to yourself and then approving it is two clicks for one act.
              (detail.soloApproval ? api.decide : api.submit)(detail.project.id, {
                expectedRevision: detail.project.revision,
                runId: current!.id,
                versions: [
                  {
                    artifactId: active.artifactId,
                    versionId: active.id,
                    contentHash: active.contentHash,
                  },
                ],
              }),
            )
          }
        />
      ) : null}


      {live.length > 0 && stage >= 7 && stage !== 8 ? <PacketSummary detail={detail} onChanged={onChanged} /> : null}
    </div>
  );
}

/** Loads the stage-4 design history and its feedback, then renders the flow. */
function DesignPanel({ detail, onChanged }: { detail: ProjectDetail; onChanged: () => void }) {
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
          onApprove: (design) =>
            (detail.soloApproval ? api.decide : api.submit)(detail.project.id, {
              expectedRevision: detail.project.revision,
              runId: detail.current!.id,
              versions: [
                { artifactId: design.artifactId, versionId: design.id, contentHash: design.contentHash },
              ],
            }),
        }}
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
      {error ? <Banner tone="error" title="Freeze refused">{error}</Banner> : null}<Button
        variant="primary"
        disabled={!readyToFreeze || !costNode}
        loading={busy}
        onClick={async () => {
          if (!costNode) return;
          setBusy(true);
          setError(null);
          try {
            await api.command(detail.project.id, "build.freeze", {
              expectedRevision: detail.project.revision,
              runId: current.id,
              versions: detail.nodes
                .filter((node) => node.supersededByNodeId === null)
                .map((node) => ({
                  artifactId: node.artifactId,
                  versionId: node.id,
                  contentHash: node.contentHash,
                })),
              placement: "local",
              targets: ["local"],
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

/** Stage 8: build supervision, capability-honest about the bounded bridge. */
function BuildPanel({ detail, onChanged }: { detail: ProjectDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<
    { id: string; type: string; severity: string; payload: Record<string, unknown>; occurredAt: string }[]
  >([]);
  const current = detail.current;

  useEffect(() => {
    void api
      .buildEvents(detail.project.id)
      .then((result) => setEvents(result.events))
      .catch(() => setEvents([]));
  }, [detail.project.id, detail.runs.length]);

  const final = events.find((event) => event.type === "bridge.final");

  return (
    <div data-tour="build-panel">
    <Screen
      title="Build supervision"
      status={
        current ? (
          <StateLabel tone={current.state === "running" ? "loading" : "selected"}>
            {current.state.replace(/_/g, " ")}
          </StateLabel>
        ) : null
      }
    >
      {error ? <Banner tone="error" title="The build attempt failed to start">{error}</Banner> : null}

      {current?.state === "queued" ? (
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.startBuild(detail.project.id, current.id);
              onChanged();
            } catch (cause) {
              setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          Start the build attempt
        </Button>
      ) : null}

      {final ? (
        <>
          <dl className="version-list">
            <div>
              <dt>Exit status</dt>
              <dd>
              {final.payload.exitStatus === 0 ? (
                <StateLabel tone="success">Exited 0</StateLabel>
              ) : (
                <StateLabel tone="error">Exited {String(final.payload.exitStatus)}</StateLabel>
              )}
            </dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd className="hash">{String(final.payload.workspace ?? "")}</dd>
            </div>
          </dl>
          <div className="artifact">
            <pre>{String(final.payload.finalText ?? "") || "(no output)"}</pre>
          </div></>
      ) : (
        <p className="inline-note">No build attempt has reported yet.</p>
      )}
    </Screen>
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

  return (
    <Screen
      title="Independent engineering review"
      description="Four principals reviewed this plan separately. Their findings are not merged."
    >
      {/* The verdict rides in the tab's own count slot, so the four can be
          compared without opening each one. */}
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
    </Screen>
  );
}

