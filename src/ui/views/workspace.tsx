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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiFailure,
  type ArtifactNode,
  type DesignFeedback,
  type ProjectDetail,
  type Quote,
  type StageTurn,
} from "../client.js";
import {
  Textarea,
  ChatInput,
  ChatThread,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  type ChatMessage,
  Switch,
} from "@corbits/react-ui";
import { ArrowUp, Check } from "lucide-react";
import { Markdown } from "../markdown.jsx";
import { markChanges } from "../revisions.js";
import { AudiencePackages } from "./audiences.jsx";
import { DesignFeedbackView } from "./design.jsx";
import {
  Banner,
  Button,
  Screen,
  StateLabel,
  RollingNumber,
  documentName,
  stageName,
} from "../components.jsx";

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

const STAGE_GOAL: Record<number, string> = {
  1: "Describe what hurts. The Brainstormer interviews the problem, not a solution.",
  2: "Bound the shape: platforms, privacy, integrations, installation, and non-goals.",
  3: "Compare at most two approaches and select one to execute.",
  4: "Work out surfaces, flows, states, and the criteria a build will be measured against.",
  5: "Prepare a package for each audience that must answer: is this worth pursuing?",
  6: "Turn the approved concept into a plan the code builder can execute, then review it four ways.",
  7: "Convert the accepted plan into a firm estimate, then approve the spend.",
  8: "Supervise the build. Humans decide permissions, material changes, and evidence.",
  9: "Review the manifest and accept or reject the delivered software.",
};

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
    import("../client.js").Remediation | undefined
  >(undefined);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [turns, setTurns] = useState<StageTurn[]>([]);
  const [openQuestion, setOpenQuestion] = useState<{ remaining: number; ordinal: number } | null>(null);

  const current = detail.current;
  const stage = current?.stage ?? 1;
  const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
  // The panel's reviews live at stage 6 alongside the plan, but they are not
  // versions of it: mixing them into one version selector reads as five drafts
  // of the same document when it is one document and four opinions of it.
  const stageNodes = detail.nodes.filter(
    (node) => node.stage === stage && node.kind !== "engineering_review",
  );
  const panelReviews = detail.nodes.filter(
    (node) => node.stage === stage && node.kind === "engineering_review",
  );
  // The draft as the model writes it. Open while a draft is in flight, so the
  // document forms on screen instead of arriving whole a minute later.
  const [writing, setWriting] = useState<string | null>(null);
  useEffect(() => {
    if (busy !== "draft") {
      setWriting(null);
      return;
    }
    const source = new EventSource(`/api/projects/${detail.project.id}/stages/${stage}/live`);
    source.addEventListener("text", (event) => {
      setWriting(JSON.parse((event as MessageEvent<string>).data) as string);
    });
    return () => source.close();
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
    } catch (cause) {
      // An empty thread and a thread that could not be read look identical on
      // screen — and that screen then asks for what the person already said.
      setTurns([]);
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

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setRemediation(undefined);
    try {
      await work();
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
    <div key={`${stage}:${phase}`} className="stage-view">
      {awaitingReview && stage <= 7 && active ? (
        <StageGate
          soloApproval={detail.soloApproval}
          busy={busy === "submit"}
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

      {stageNodes.length === 0 && inProgress && stage <= 7 ? (
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
          <Preparing stage={stage} said={said} writing={writing} busy={busy === "draft"} />
        )
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

      {stage === 5 ? <AudiencePackages detail={detail} onChanged={onChanged} /> : null}

      {stage === 8 ? <BuildPanel detail={detail} onChanged={onChanged} /> : null}

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


      {live.length > 0 && stage >= 7 ? <PacketSummary detail={detail} onChanged={onChanged} /> : null}
    </div>
  );
}

/**
 * The stage is written and waits on a decision. Working alone, the decision is
 * one click here and the next stage begins at once; with others involved, this
 * says who the wait is on and where to go.
 */
function StageGate({
  soloApproval,
  busy,
  onApprove,
  onOpenDecisions,
}: {
  soloApproval: boolean;
  busy: boolean;
  onApprove: () => void;
  onOpenDecisions?: (() => void) | undefined;
}) {
  return (
    <div className="stage-gate" role="status">
      <span className="stage-gate-dot" aria-hidden="true" />
      <p>
        {soloApproval
          ? "This version is ready. Approving it starts the next stage."
          : "This version is with the people who decide. It moves on when they have."}
      </p>
      {soloApproval ? (
        <Button variant="primary" loading={busy} onClick={onApprove}>
          <Check aria-hidden="true" />
          Approve and continue
        </Button>
      ) : onOpenDecisions ? (
        <Button variant="ghost" onClick={onOpenDecisions}>
          Open the decision queue
        </Button>
      ) : null}
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
    <>
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
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </>
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
  );
}

/**
 * A drafted stage: the document, and the conversation about it.
 *
 * Exported so `scripts/walk-ui.tsx` renders this rather than a copy. The copy
 * drifted within a day — it was still showing a header and a button row that
 * had been redesigned — which is the whole reason the harness is not allowed
 * to describe surfaces itself.
 *
 * One composer, because there is one thing a person does here — say what
 * should change — and it does not become two things because they happened to
 * select some text first. Selecting a passage attaches it to the message being
 * written, and several can be attached before sending. Typing without
 * selecting anything is the ordinary case and stays ordinary.
 */
export function StageDocument({
  node,
  versions,
  content,
  turns,
  openQuestion,
  onSelectVersion,
  onRevise,
  onSubmit,
  soloApproval,
  canSubmit,
  busy,
  draftOpen = true,
  newer = null,
  live = null,
}: {
  node: ArtifactNode;
  versions: ArtifactNode[];
  content: string;
  turns: StageTurn[];
  /** Set while the specialist is still waiting on an answer. */
  openQuestion: { remaining: number; ordinal: number } | null;
  onSelectVersion: (id: string) => void;
  onRevise: (message: string, quotes: Quote[], revise?: boolean) => void;
  onSubmit: () => void;
  soloApproval: boolean;
  canSubmit: boolean;
  busy: string | null;
  /** The draft pane beside the conversation; the header's toggle. */
  draftOpen?: boolean;
  /** A version newer than the one being read, when there is one. */
  newer?: ArtifactNode | null;
  /** The next version, as far as the model has written it. */
  live?: string | null;
}) {
  const [message, setMessage] = useState("");
  const [attached, setAttached] = useState<Quote[]>([]);
  // Against the version before this one, like tracked changes: what a revision
  // did is otherwise something the reader has to find by rereading the whole
  // document.
  const previous = versions.find((entry) => entry.version === node.version - 1) ?? null;
  const [showChanges, setShowChanges] = useState(true);
  const [previousContent, setPreviousContent] = useState<string | null>(null);
  useEffect(() => {
    setPreviousContent(null);
    if (!previous) return;
    let cancelled = false;
    void api
      .artifact(previous.id)
      .then((result) => {
        if (!cancelled) setPreviousContent(result.content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [previous?.id]);
  // Closed by default. While the specialist is still asking, the document is
  // the thing being written rather than the thing being read, and a wall of
  // draft beside a question is what made this feel like homework.
  const composer = useRef<HTMLTextAreaElement>(null);
  // ChatThread owns the transcript's scrolling, including staying put while
  // the reader is scrolled up.

  /** A selection in the document attaches to the message being written. */
  const attachSelection = () => {
    const selection = globalThis.getSelection?.();
    const text = selection?.toString().trim() ?? "";
    if (text.length === 0) return;
    const quote = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    if (attached.some((entry) => entry.quote === quote)) return;
    setAttached([...attached, { quote }]);
    selection?.removeAllRanges();
    composer.current?.focus({ preventScroll: true });
  };

  // Our turns as the library's message model. A quote the person attached is
  // part of what they said, so it travels in the same message rather than
  // becoming a second kind of thing.
  // Memoised: the thread re-pins its scroll whenever this array is new, and a
  // fresh one on every keystroke in the composer made the transcript twitch.
  const messages: ChatMessage[] = useMemo(() => {
    const list: ChatMessage[] = turns.map((turn) => ({
      id: turn.id,
      role: turn.role === "specialist" ? "agent" : "user",
      createdAt: turn.createdAt,
      parts: [
        ...turn.quotes.map((entry) => ({ type: "text" as const, text: `> ${entry.quote}` })),
        { type: "text" as const, text: turn.body },
      ],
    }));
    // A turn in flight has no row of its own yet, so the transcript would sit
    // unchanged after the person hits send. This is the one message the thread
    // shows that the host has not recorded.
    if (busy === "draft") {
      list.push({
        id: "pending",
        role: "agent",
        createdAt: new Date().toISOString(),
        parts: [{ type: "text", text: "Writing…" }],
      });
    }
    return list;
  }, [turns, busy]);

  // What each specialist turn did with the answer before it: which version the
  // answer produced, and whether the question that follows continues the same
  // interview or opens a new one after a full re-read. The turn itself only
  // says the question, so without this an answer looks unheard.
  const versionOf = new Map(versions.map((entry) => [entry.id, entry.version]));
  const noun = documentName(node.kind).toLowerCase();
  const notes = new Map<string, TurnNote>();
  turns.forEach((turn, index) => {
    if (turn.role !== "specialist") return;
    const answered = turns[index - 1]?.role === "human";
    const version = turn.resultNodeId ? (versionOf.get(turn.resultNodeId) ?? null) : null;
    if (!answered && version === null) return;
    notes.set(turn.id, {
      answered,
      version,
      nodeId: turn.resultNodeId,
      fresh: turn.body.startsWith("The draft is beside this"),
      noun,
    });
  });

  // The composer grows as a person types. The transcript above it shrinks by
  // the same amount, and unless it is re-pinned in the same frame the last
  // line slides under the box and back out again on every wrap.
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = pane.current;
    const box = section?.querySelector<HTMLElement>(".composer");
    const log = section?.querySelector<HTMLElement>('[role="log"]');
    if (!box || !log) return;
    let pinned = true;
    const onScroll = () => {
      pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    };
    log.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(() => {
      if (pinned) log.scrollTop = log.scrollHeight;
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      log.removeEventListener("scroll", onScroll);
    };
  }, [messages.length === 0]);

  const send = () => {
    if (message.trim().length === 0 && attached.length === 0) return;
    onRevise(message.trim(), attached);
    setMessage("");
    setAttached([]);
  };

  return (
    <div className={draftOpen ? "document-layout" : "document-layout is-solo"}>
      <section ref={pane} className="stage-thread" aria-label="Conversation with the specialist">
        <header className="thread-head">
          {/* With the draft open its own header names the stage, so this says
              only what that does not. */}
          {/* The draft's own header carries the stage, so this says only what
              that does not. */}
          <span className="thread-progress">
            {openQuestion ? (
              <>
                Question <RollingNumber value={openQuestion.ordinal + 1} /> of{" "}
                <RollingNumber value={openQuestion.ordinal + 1 + openQuestion.remaining} />
              </>
            ) : (
              ""
            )}
          </span>
        </header>

        <ChatThread
          className="thread-turns"
          messages={messages}
          identity={{ name: "Specialist", initials: "SB" }}
          // A specialist's turn is its digest of the draft, and the bolding in
          // it is the point — it is what a reader takes in first.
          renderBody={(message) =>
            message.id === "pending" ? (
              <span className="thinking">Writing</span>
            ) : message.role === "agent" ? (
              <SpecialistTurn
                text={(message.parts[0] as { text: string }).text}
                note={notes.get(message.id) ?? null}
                onOpenVersion={onSelectVersion}
              />
            ) : undefined
          }
          empty={
            <div className="thread-empty">
              <p>The specialist has not spoken yet.</p>
              <p>Draft this stage and it opens with what it found.</p>
            </div>
          }
        />

        <div className="composer" data-tour="composer" data-working={busy === "draft" || undefined}>
          {/* The specialist has gone quiet without asking anything. Whose move
              it is has to be said, or the screen reads as stuck. */}
          {canSubmit && !openQuestion && busy === null && turns.at(-1)?.role === "specialist" && !turns.at(-1)!.body.trimEnd().endsWith("?") ? (
            <p className="composer-cue">
              Nothing more to ask. Approve it, or say what should change and it will redraft.
            </p>
          ) : null}
          {canSubmit ? (
            <div className="composer-approve">
              <span>{soloApproval ? "Happy with it?" : "Nothing more to say?"}</span>
              <span data-tour="submit">
                <Button variant="ghost" loading={busy === "submit"} onClick={onSubmit}>
                  <Check aria-hidden="true" />
                  {soloApproval ? "Approve and continue" : "Send for approval"}
                </Button>
              </span>
            </div>
          ) : null}
          <ChatInput
            value={message}
            onValueChange={setMessage}
            onSend={send}
            working={busy === "draft"}
            disabled={busy !== null}
            placeholder={
              busy === "draft"
                ? "The specialist is writing…"
                : attached.length > 0
                  ? "What should change about this?"
                  : openQuestion
                    ? "Your answer. Rough is fine."
                    : "What should change? Add as much as you like."
            }
            attachments={attached.map((entry, index) => ({
              id: `${index}`,
              name: entry.quote,
            }))}
            onRemoveAttachment={(entry) =>
              setAttached(attached.filter((_, at) => `${at}` !== entry.id))
            }
            textareaRef={composer}
          />
        </div>
      </section>

      <article className="document" data-tour="document">
        <header className="document-header">
          <h2>{documentName(node.kind)}</h2>
          {live !== null ? (
            <span className="thinking">Writing version {node.version + 1}</span>
          ) : newer ? (
            <button type="button" className="newer-version" onClick={() => onSelectVersion(newer.id)}>
              <ArrowUp aria-hidden="true" />
              Version {newer.version} is ready
            </button>
          ) : null}
          <div className="document-tools">
          {previous ? (
            <label className="changes-toggle" htmlFor="show-changes">
              <Switch id="show-changes" checked={showChanges} onCheckedChange={setShowChanges} />
              <span>Changes since v{previous.version}</span>
            </label>
          ) : null}
          {versions.length > 1 ? (
            <select
              aria-label="Version"
              value={node.id}
              onChange={(event) => onSelectVersion(event.target.value)}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  Version {version.version}
                  {version.supersededByNodeId ? " (superseded)" : ""}
                </option>
              ))}
            </select>
          ) : null}
          </div>
        </header>
        <div className="document-body" data-tour="document-body" onMouseUp={attachSelection}>
          {live !== null ? (
            <div className="is-live">
              <Markdown source={live} />
            </div>
          ) : content ? (
            <Markdown
              source={
                showChanges && previousContent !== null ? markChanges(previousContent, content) : content
              }
            />
          ) : (
            <p className="inline-note">Loading…</p>
          )}
        </div>
      </article>
    </div>
  );
}

/**
 * A specialist's turn ends in the question it is asking. Set apart from what
 * came before it, so a reader can tell what they are being asked from what
 * they are being told.
 */
type TurnNote = {
  /** A person spoke just before this turn. */
  answered: boolean;
  version: number | null;
  nodeId: string | null;
  /** Opens a new round of questions after re-reading everything. */
  fresh: boolean;
  /** What the document is called, lower case: "problem brief", "constraints". */
  noun: string;
};

function SpecialistTurn({
  text,
  note,
  onOpenVersion,
}: {
  text: string;
  note: TurnNote | null;
  onOpenVersion: (nodeId: string) => void;
}) {
  const cut = text.lastIndexOf("\n\n");
  const last = (cut >= 0 ? text.slice(cut + 2) : text).trim();
  const question = last.endsWith("?") ? last : null;
  const before = question ? text.slice(0, Math.max(cut, 0)) : text;
  return (
    <>
      {note ? (
        <p className="turn-note">
          {note.answered ? <span>Noted</span> : null}
          {note.version !== null && note.nodeId ? (
            <button type="button" className="turn-version" onClick={() => onOpenVersion(note.nodeId!)}>
              {note.noun} updated to v{note.version}
            </button>
          ) : null}
          {question ? <span>{note.fresh ? "new round of questions" : "next question"}</span> : null}
        </p>
      ) : null}
      {before.trim() ? <Markdown source={before} /> : null}
      {question ? <p className="turn-question">{question}</p> : null}
    </>
  );
}

const STAGE_TIPS: Record<number, string[]> = {
  1: [
    "The specialist interviews the problem, not a solution. Answer with what hurts, not what to build.",
    "One real example beats a general description. Name the last time this cost you an afternoon.",
    "Rough answers are fine. Every answer becomes a new version of the brief, and you approve before anything is built.",
  ],
  2: [
    "This stage bounds the shape: platforms, privacy, integrations, installation and what is out of scope.",
    "Non-goals are as valuable as goals. Saying what this will not do keeps the build honest.",
    "If a constraint feels obvious, say it anyway. The specialist only knows what the approved brief says.",
  ],
  3: [
    "At most two approaches are compared, and one is selected. More options is not more clarity.",
    "The comparison is against the success criteria from stage 1, so weak criteria make a weak choice.",
    "You can reject the selection and ask for the other approach. That is a normal outcome, not a failure.",
  ],
  4: [
    "Design works out surfaces, flows and states, and the criteria the build is measured against.",
    "Every state matters: empty, loading, error and success. A flow that only shows the happy path hides the work.",
    "Feedback on a screen can quote it directly. Select text in the draft to attach it to what you say.",
  ],
  5: [
    "Each audience gets its own package answering one question: is this worth pursuing?",
    "A package is written for its reader. A founder and an engineer should not be handed the same page.",
    "Stage 5 needs a quorum. The project moves on when enough audiences have decided.",
  ],
  6: [
    "The plan is what the code builder executes, so vagueness here becomes vagueness in the build.",
    "Four principals review the plan separately. Their findings are not merged, so you can see where they disagree.",
    "A plan step you cannot picture being done is a step the builder cannot do either.",
  ],
  7: [
    "The estimate is firm, not a range. Approving it approves the spend.",
    "Cost follows the plan. If the number surprises you, the place to push back is stage 6.",
    "Nothing is built until this is approved.",
  ],
};

/**
 * The stage before it has a draft: the specialist is reading and writing, and
 * this is the whole screen while it does. A form to fill in here asked for
 * something the approved work already says; a table of past decisions below it
 * answered a question nobody was asking.
 */
function Preparing({
  stage,
  said,
  writing,
  busy,
}: {
  stage: number;
  said: StageTurn[];
  writing: string | null;
  busy: boolean;
}) {
  const tips = STAGE_TIPS[stage] ?? STAGE_TIPS[1]!;
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTip((at) => (at + 1) % tips.length), 7_000);
    return () => clearInterval(timer);
  }, [tips.length]);

  return (
    <section className="preparing" aria-live="polite">
      <header className="preparing-head">
        <p className="preparing-kicker">
          Stage <RollingNumber value={stage} /> of 9
        </p>
        <h2>Preparing {stageName(stage).toLowerCase()}</h2>
        <p className="preparing-goal">{STAGE_GOAL[stage]}</p>
      </header>

      {writing ? (
        <div className="preparing-draft is-live">
          <Markdown source={writing} />
        </div>
      ) : (
        <div className="preparing-activity">
          <span className="thinking">
            {busy
              ? said.length > 0
                ? "Reading what you wrote"
                : "Reading the approved work from earlier stages"
              : "Starting"}
          </span>
          <p key={tip} className="preparing-tip">
            {tips[tip]}
          </p>
        </div>
      )}
    </section>
  );
}

/** Every decision recorded on this project, oldest first. Lives with the artifacts. */
export function ApprovalsRecord({ approvals }: { approvals: ProjectDetail["approvals"] }) {
  if (approvals.length === 0) return null;
  return (
    <details className="approvals-record">
      <summary>Recorded approvals ({approvals.length})</summary>
      <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((approval) => (
                <TableRow key={approval.id}>
                  <TableCell>{new Date(approval.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{approval.stage}</TableCell>
                  <TableCell>
                    {approval.command}
                    {approval.audienceName ? ` (${approval.audienceName})` : ""}
                  </TableCell>
                  <TableCell>
                    <StateLabel
                      tone={
                        approval.decision === "approve" || approval.decision === "accept"
                          ? "success"
                          : approval.decision === "reject"
                            ? "error"
                            : "warning"
                      }
                    >
                      {approval.decision}
                    </StateLabel>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
    </details>
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
